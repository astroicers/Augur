# Augur 監控 stack — Windows 主機效能/安全 → panel 語音告警

用 Docker 起一套 **Grafana + Prometheus + Loki**，監控 **Windows 主機**的效能與安全。
告警由 dashboard 上的 **`augur-mascot-panel`** 自己 pull 並念出來 —— 沒有後端、沒有 webhook。

> 2026-09-21 整份重寫。先前描述的 bridge 架構（`:3001` webhook 接收端）已於 `fbd81f4`
> 隨舊管線一起刪除，ADR-004 把 Augur 改成 Grafana panel plugin。

## 架構

```
 Windows 主機                              WSL (mirrored) + Docker Desktop
 ─────────────                            ───────────────────────────────
 windows_exporter :9182 ──── scrape ────▶ Prometheus (容器 9090 / host 9091)
 Grafana Alloy          ──── push  ─────▶ Loki       (容器 3100 / host 3101)
   (Windows Event Log)   localhost:3101         │ datasources
                                                ▼
                                          Grafana (容器 3000 / host 3002)
                                          └ ../dist 掛成 plugin
                                                ▼
                                    瀏覽器分頁裡的 augur-mascot-panel
                                    （讀自己的 alertState → Web Speech 念出）
```

**語音跑在看 dashboard 的那台機器的瀏覽器裡**，不在 Grafana 容器內 ——
所以 Linux 容器沒有語音引擎這件事不影響任何東西。

Port 刻意避開本機既有的 `fh-lgtm`（3000/3100/9090）：**Grafana 3002、Prometheus 9091、Loki 3101**。

## 先決條件

- Docker Desktop（WSL 整合）。
- **先 `npm run build`。** compose 掛的是 `../dist`，那是建置產物；沒建置過的話目錄不存在，
  Grafana 會正常起來但選單裡就是沒有這個 plugin，**而且不會有任何錯誤訊息**。
  `npm run server`（在 repo 根）已經把 build 串在前面。
- 瀏覽器需支援 Web Speech API（Chrome / Edge 是實測過的）。中文語音由**作業系統**提供，
  瀏覽器只是把 OS 有的拿出來用。

## 啟動（WSL 端）

分兩段:**效能是預設、安全是 opt-in**(用 compose profile 控制,避免一次扛太多)。

```bash
cd monitoring
cp .env.example .env            # 填 GF 帳密。WEBHOOK_SECRET 已無用途（bridge 已刪），見下方待裁定段

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
- 確認告警：Alerting → Alert rules 應有「Augur Windows」資料夾下 8 條規則，
  以及 POC 資料夾下的 `PocAlwaysFiring` / `PocFlapping` 兩條
- **確認 plugin**：Administration → Plugins → 搜尋 `Mascot`。
  看不到就是 `../dist` 沒建置，或 unsigned 白名單沒生效。
- **POC dashboard**：Dashboards → `Augur POC — alertState 探測`（uid `augur-poc`）。
  **五個 panel**：四個 Mascot（id 1 / 3 / 4 / 5）＋一個 timeseries 對照組（id 2）。
  ⚠️ **panel id 4 與 5 是有作用的**：`rules-perf.yml` 的 3 條與 `rules-security.yml` 的 5 條
  用 `__panelId__` 綁的就是這兩個數字，改動 id 會讓那 8 條規則的 alertState 到不了 panel。

### plugin 是怎麼掛上去的

compose 已經配好三件事，不需要手動設定：

| 設定 | 值 | 作用 |
|---|---|---|
| volume | `../dist:/var/lib/grafana/plugins/augur-mascot-panel:ro` | 掛的是**建置產物**。Grafana 掃的是「含 `plugin.json` 的目錄」，而原始碼樹裡那個檔在 `src/` 下，掛原始碼是掃不到的。 |
| `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` | `augur-mascot-panel` | 未簽署的 plugin 預設不載入。 |
| `GF_SECURITY_ENABLE_FRONTEND_SANDBOX_FOR_PLUGINS` | `${SANDBOX_PLUGINS:-}`（預設空） | 見下方〈降級實測〉。 |

> 若 plugin 目錄裡殘留舊的 `MANIFEST.txt`，Grafana 會直接拒載且不吃白名單 ——
> 簽章被改過的 plugin 一律不載入。刪掉重建。

### 降級實測（跨 panel 互動的漸進降級）

Frontend Sandbox 會擋住 plugin 伸手到自己 panel 以外的 DOM，
也就是「全頁視線追蹤」與「點擊偵測」依賴的東西。本 plugin 的設計是**降級而不是崩潰**。

```bash
SANDBOX_PLUGINS=augur-mascot-panel docker compose -f monitoring/docker-compose.yml up -d
```

重新載入 dashboard，panel 抬頭的 chip 應該從「全頁追蹤」變成「**限本 panel**」，
其餘功能照常。這個 chip 是降級唯一看得見的證據 —— 沒有它就沒有東西可以驗。
測完把環境變數拿掉再 `up -d` 一次即可還原。

## Windows 端（系統管理員 PowerShell）

把 `windows/` 整個資料夾複製到 Windows，開**系統管理員** PowerShell：

```powershell
# 1) 效能 exporter（預設就需要）
powershell -ExecutionPolicy Bypass -File .\windows_exporter-install.ps1

# 2) 安全日誌代理 —— 只有當你開了 `--profile security`（Loki 有起）時才裝
powershell -ExecutionPolicy Bypass -File .\alloy-install.ps1
```

> 兩個都需系統管理員。**它們各自會做什麼、以及怎麼移除，寫在腳本檔頭。**
> 摘要：`windows_exporter-install.ps1` 裝 MSI + 註冊 Windows 服務 + 新增一條 inbound 防火牆規則（TCP 9182）；
> `alloy-install.ps1` 裝 exe + 註冊 Windows 服務（**以 LocalSystem 執行** —— 那是它讀得到
> Security 事件日誌的原因，也代表它的權限很高），不碰防火牆。
> **效能模式只需第 1 支**；Alloy 留到你要安全那半時再裝。

### 版本與雜湊（釘住的，不是每次抓最新）

兩支腳本都**釘住版本**並在安裝前比對 SHA256，不符就刪檔並 `throw`。
`releases/latest` 會讓「今天裝的」與「上週裝的」是不同的二進位，而兩者都自稱通過了同一份驗收。

| 元件 | 釘住的版本 | 資產 | SHA256 來源 | 查證日 |
|---|---|---|---|---|
| windows_exporter | `v0.31.8`（release 發布於 2026-07-22） | `windows_exporter-0.31.8-amd64.msi` | 該 release 的 `sha256sums.txt`：<br>`https://github.com/prometheus-community/windows_exporter/releases/download/v0.31.8/sha256sums.txt` | 2026-09-21 |
| Grafana Alloy | `v1.19.2`（release 發布於 2026-08-26） | `alloy-installer-windows-amd64.exe` | 該 release 的 `SHA256SUMS`：<br>`https://github.com/grafana/alloy/releases/download/v1.19.2/SHA256SUMS` | 2026-09-21 |

**升版的作法**：改腳本裡的 `$version`，去上表的 URL 取新的雜湊填進 `$expectedSha256`，
並把本表的查證日更新。**不要**改回自動抓最新版。

### 防火牆規則限縮了來源

`windows_exporter` 的那條 inbound 規則帶 `-RemoteAddress 172.16.0.0/12, 192.168.65.0/24, 127.0.0.1`
（Docker Desktop 的 host-gateway 網段）。Prometheus 是從容器經 `host.docker.internal` 抓的，
不需要讓網段上任何機器都讀得到 —— `/metrics` 含服務清單、磁碟與網路介面資訊，那是主機的側寫資料。

若你的 Docker 用的網段不在清單內，Prometheus 會抓不到。
用 `docker network inspect bridge` 查出實際網段後補進腳本的 `$allowedRemote`。
腳本對**既有規則**會就地收斂（舊版建立的可能是對全部來源開放），不會當作已經好了就跳過。

## ⚠️ contactpoints / policies：待裁定，目前不通往任何地方

`grafana/provisioning/alerting/contactpoints.yml` 仍然指向
`http://host.docker.internal:3001/grafana/webhook` —— **那個 bridge 已於 `fbd81f4` 刪除**。
它現在是一份指向不存在服務的 webhook 設定。

**為什麼還留著**：ADR-004 決策 7（Accepted）寫的是「`monitoring/` **全套**保留」，
而計畫 P3 寫的是「**丟**掉這兩個檔」。兩造正面衝突，且 ADR 的效力高於計畫。
三條可能的解與裁定狀態見 **`../docs/ROADMAP.md`〈未解決的衝突〉**。

**與裁定無關、但不該一起拖著的一件事**：`WEBHOOK_SECRET` 曾出現在容器環境變數與
provisioning 檔裡。不論上面選哪一條，**那應該由人輪換**。

## 驗證（端到端）

驗的是**panel 有沒有念出來**，不是「bridge log 有沒有印」—— 後者已經不存在了。

### 最快的一條：POC 恆定告警

1. 開 `Augur POC — alertState 探測` dashboard。
2. 第一個 Mascot panel 的抬頭應該顯示 `alertState: alerting`。
3. 點一次「啟用語音」按鈕（瀏覽器要求一次使用者手勢），應該聽到它念出
   `PocAlwaysFiring` 的 summary。
4. 等幾個 refresh interval，**它不該再念第二次** —— 那是 dedup 在生效。

`PocFlapping` 那條配 `for: 20s` 且每分鐘翻轉，用來觀察 pending / alerting / normal
三態轉換：抬頭的 `alertState:` chip 會依序跑過這三個值。

### ⚠️ 看不到 alertState 時，先確認這兩件事再懷疑 annotations

1. **先載入 dashboard、之後才建立 alert rule 的話，必須整頁重新載入。**
   Grafana 對「這個 dashboard 有沒有 alert rule」有一個 latch，
   provisioning 熱重載不會更新它。這是 ADR-004 決策 2 與 P2-handoff 都記過的坑 ——
   不知道的話會把它誤診成「`__dashboardUid__` / `__panelId__` 註解填錯了」，
   然後去改一個本來就對的東西。
2. **`plugin.json` 不可設 `skipDataQuery`。** 設了的話 panel 不會拿到任何 data，
   `alertState` 自然也不會來。

其餘三個硬前提（panel 至少一個 query、rule 帶 `__dashboardUid__`/`__panelId__` 註解、
dashboard 時間範圍結尾為 `now`）見 `../src/README.md`。

### 基礎連通

```bash
# Prometheus 是否抓到 Windows
docker exec augur-prometheus wget -qO- 'http://localhost:9090/api/v1/targets' | grep windows-host
```

- **效能**：Windows 跑 CPU 壓力 → `WindowsHighCPU` 轉 firing → panel 換成 critical 表情並念出。
  ```powershell
  # 製造 CPU 負載約 3 分鐘
  1..([Environment]::ProcessorCount) | ForEach-Object { Start-Job { while($true){} } }
  # 結束：Get-Job | Stop-Job; Get-Job | Remove-Job
  ```
  ✅ `rules-perf.yml` 與 `rules-security.yml` 的 8 條真實規則**已於 2026-09-21 補上**
  `__dashboardUid__` / `__panelId__`（A5-4），分別綁 panel 4 與 5。
  連同 `rules-poc.yml` 的 2 條，這台 Grafana 上 10 條規則全部帶齊註解。
- **安全**：Windows 故意連續登入失敗 → `WindowsFailedLogonBurst` firing。
  先在 Grafana → Explore → Loki 查 `{job="windows-eventlog"} |= "An account failed to log on"`
  確認有資料。註解已補齊（見上），所以裝好 Alloy 之後就能直接驗。

## 告警門檻 / 規則調整

- 效能門檻：`grafana/provisioning/alerting/rules-perf.yml`（CPU>85、Mem<10%、Disk<10%）。
- 安全片語：`grafana/provisioning/alerting/rules-security.yml`（失敗登入>5、鎖定/清日誌/裝服務/Defender>0）。
- 改完 `docker compose restart grafana` 重新 provision。
- 嚴重度標籤 `severity` 由 panel 的「最低播報嚴重度」選項過濾，並決定表情與語音內容。
  值域見 `../src/core/severity.ts` 的 RANK 表。
- POC 規則：`rules-poc.yml`（`PocAlwaysFiring` 恆定 firing、`PocFlapping` 每分鐘翻轉）。
  它們是唯一帶齊 `__dashboardUid__` / `__panelId__` 註解的規則。

## 疑難排解

| 症狀 | 處置 |
|---|---|
| Grafana 起不來 / provisioning 報錯 | `docker compose logs grafana \| grep -i provision` |
| windows-host target DOWN | Windows 防火牆 9182；`http://localhost:9182/metrics` 在 Windows 本機能開嗎 |
| Loki 查無 `{job="windows-eventlog"}` | Alloy 服務沒起 / 設定沒套；看 Alloy UI http://localhost:12345 |
| Add panel 裡沒有 Mascot | `../dist` 沒建置（先 `npm run build`），或 unsigned 白名單沒生效，或殘留 `MANIFEST.txt` |
| panel 顯示 `alertState: —` | Grafana 根本沒送 alert state。四個硬前提見 `../src/README.md`；先確認有沒有整頁重新載入過 |
| panel 有表情但不出聲 | 點一次「啟用語音」；或 OS 沒裝中文語音（panel 會降級到可用的聲線） |
| chip 顯示「限本 panel」 | Frontend Sandbox 開著。那是**預期的降級**不是壞掉 |
| 安全片語對不上 | 在 Loki Explore 看真實 log 行，回頭改 rules-security.yml 的 `\|=` 片語 |

## 停止 / 清除

```bash
docker compose down            # 停止（保留資料 volume）
docker compose down -v         # 連同 Prometheus/Loki/Grafana 資料一起刪
```
