# Augur 監控 stack — Windows 主機效能/安全 → 語音告警

用 Docker 起一套 **Grafana + Prometheus + Loki**，監控 **Windows 主機**的效能與安全，
告警經 Webhook 灌進 **Augur bridge** → AIRI 角色用語音念出。

## 架構

```
 Windows 主機                              WSL (mirrored) + Docker Desktop
 ─────────────                            ───────────────────────────────
 windows_exporter :9182 ──── scrape ────▶ Prometheus (容器 9090 / host 9091)
 Grafana Alloy          ──── push  ─────▶ Loki       (容器 3100 / host 3101)
   (Windows Event Log)   localhost:3101         │ datasources
 AIRI 桌面版 :6121                              ▼
        ▲                                 Grafana (容器 3000 / host 3002)
        │ input:text                      └ 告警 → Webhook contact point
        │                                          │ POST host.docker.internal:3001
 Augur bridge (WSL 原生, :3001, HOST=0.0.0.0) ◀────┘
```

Port 刻意避開本機既有的 `fh-lgtm`（3000/3100/9090）：**Grafana 3002、Prometheus 9091、Loki 3101**。

## 先決條件

- Docker Desktop（WSL 整合）。
- Augur bridge 已能連上 AIRI（見 [`../docs/airi-runbook.md`](../docs/airi-runbook.md)）。
- bridge `.env` 需設 **`HOST=0.0.0.0`**（讓 Grafana 容器經 `host.docker.internal:3001` 連回）。

## 啟動（WSL 端）

分兩段:**效能是預設、安全是 opt-in**(用 compose profile 控制,避免一次扛太多)。

```bash
cd monitoring
cp .env.example .env            # 填 GF 帳密；WEBHOOK_SECRET 必須與 bridge .env 一致

# 預設 = 只起效能（Grafana + Prometheus，2 容器）
docker compose up -d
docker compose ps               # grafana/prometheus 應 Up（沒有 loki）

# 之後想要「安全」那半時，才把 Loki 也起來（再去 Windows 裝 Alloy）
docker compose --profile security up -d
```

> 效能模式下 Grafana 仍會 provision Loki datasource 與 5 條安全規則,但因 Loki 沒起 →
> datasource 顯示 unavailable、安全規則停在 No Data(設了 `noDataState/execErrState: OK`,**不會誤報**)。
> 開了 `--profile security` 並裝好 Alloy 後就會活起來。這是預期行為。
>
> 關閉安全那半:`docker compose stop loki`(或重新 `docker compose up -d` 不帶 profile)。

- Grafana：http://localhost:3002 （帳密見 `.env`）
- 確認 datasource：Connections → Data sources 應有 Prometheus、Loki
- 確認告警：Alerting → Alert rules 應有「Augur Windows」資料夾下 8 條規則

## Windows 端（系統管理員 PowerShell）

把 `windows/` 整個資料夾複製到 Windows，開**系統管理員** PowerShell：

```powershell
# 1) 效能 exporter（預設就需要）
powershell -ExecutionPolicy Bypass -File .\windows_exporter-install.ps1

# 2) 安全日誌代理 —— 只有當你開了 `--profile security`（Loki 有起）時才裝
powershell -ExecutionPolicy Bypass -File .\alloy-install.ps1
```

> 兩個都需系統管理員（裝服務 + 改防火牆）。Alloy 以 LocalSystem 執行才讀得到 Security 事件。
> **效能模式只需第 1 支**;Alloy 留到你要安全那半時再裝。

## 接 bridge

`grafana/provisioning/alerting/contactpoints.yml` 已指向 `http://host.docker.internal:3001/grafana/webhook`，
Bearer = `$WEBHOOK_SECRET`（compose 由 `.env` 注入）。**只要 `.env` 的 `WEBHOOK_SECRET` 與 bridge 一致即自動接上**，無需手動在 Grafana UI 設定。

## 驗證（端到端）

```bash
# 容器 → bridge 連通
docker exec augur-grafana wget -qO- http://host.docker.internal:3001/healthz
# Prometheus 是否抓到 Windows
docker exec augur-prometheus wget -qO- 'http://localhost:9090/api/v1/targets' | grep windows-host
```

- **效能**：Windows 跑 CPU 壓力 → `WindowsHighCPU` 轉 firing → bridge log 印播報 → AIRI 念出。
  ```powershell
  # 製造 CPU 負載約 3 分鐘
  1..([Environment]::ProcessorCount) | ForEach-Object { Start-Job { while($true){} } }
  # 結束：Get-Job | Stop-Job; Get-Job | Remove-Job
  ```
- **安全**：Windows 故意連續登入失敗（同帳號錯密碼多次）→ `WindowsFailedLogonBurst` firing → AIRI 念出。
  先在 Grafana → Explore → Loki 查 `{job="windows-eventlog"} |= "An account failed to log on"` 確認有資料。

## 告警門檻 / 規則調整

- 效能門檻：`grafana/provisioning/alerting/rules-perf.yml`（CPU>85、Mem<10%、Disk<10%）。
- 安全片語：`grafana/provisioning/alerting/rules-security.yml`（失敗登入>5、鎖定/清日誌/裝服務/Defender>0）。
- 改完 `docker compose restart grafana` 重新 provision。
- 嚴重度標籤 `severity` 對應 bridge 的 `MIN_SEVERITY` 過濾與語音內容。

## 疑難排解

| 症狀 | 處置 |
|---|---|
| Grafana 起不來 / provisioning 報錯 | `docker compose logs grafana \| grep -i provision` |
| windows-host target DOWN | Windows 防火牆 9182；`http://localhost:9182/metrics` 在 Windows 本機能開嗎 |
| Loki 查無 `{job="windows-eventlog"}` | Alloy 服務沒起 / 設定沒套；看 Alloy UI http://localhost:12345 |
| 告警不送到 bridge | `.env` 的 `WEBHOOK_SECRET` 與 bridge 不一致；或 bridge `HOST` 不是 0.0.0.0 |
| 安全片語對不上 | 在 Loki Explore 看真實 log 行，回頭改 rules-security.yml 的 `\|=` 片語 |

## 停止 / 清除

```bash
docker compose down            # 停止（保留資料 volume）
docker compose down -v         # 連同 Prometheus/Loki/Grafana 資料一起刪
```
