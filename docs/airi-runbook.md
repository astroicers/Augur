# AIRI / LLM / Grafana 設定 Runbook（Augur）

把「讓桌面 AIRI 被 Augur 連上、用語音念出告警」的手動設定記在這裡。
以下是**本專案實際驗證過的設定**，環境為：bridge 跑在 WSL、AIRI 桌面版 + 本地 LLM 跑在 Windows。
這些是 AIRI / LLM / Grafana 端的設定，不在 bridge 程式內。

## 0. 環境拓樸

- **bridge（Augur）** 在 **WSL**；**AIRI 桌面版（stage-tamagotchi）** 在 **Windows**。
- 兩者用 WebSocket 通訊（預設 port `6121`、path `/ws`）。
- WSL 為 **mirrored networking** 時，WSL 的 `localhost` 直接通到 Windows → 用 `ws://localhost:6121/ws` 即可，**不必**改 hostname 或填 host IP。
  - 確認：WSL 跑 `timeout 2 bash -c 'echo > /dev/tcp/localhost/6121'`，能連代表通。
  - 若非 mirrored 模式：AIRI 連線頁 hostname 改 `0.0.0.0`，`AIRI_WS_URL` 改用 Windows host IP（`ip route show default | awk '{print $3}'`）。

## 1. LLM brain（角色的大腦）

Augur 送 `input:text` 給 AIRI，AIRI 用它的 LLM 產生回應再唸出，所以 AIRI 要先接一個 LLM。

本專案用本地 **llama.cpp 的 `llama-server`**（OpenAI 相容），在 Windows 啟動：

```
llama-server.exe -m models\<model>.gguf --host 0.0.0.0 --port 8080 -c 4096 -ngl 999 --no-warmup
```

- ⚠️ **VRAM 雷**：12GB 顯卡（如 RTX 4070）跑 12B **Q8**（~11.8GiB）會溢位 → 生成慢（~4 tok/s）且 **AIRI 的 WebGPU 渲染被餓死而不穩/當機**。改用 **Q4_K_M**（~7GB）可全層上 GPU，同時解「慢」與「不穩」。啟動 log 應見 `offloaded N/N layers to GPU`、無 `failed to fit ... abort`。

AIRI 端接法：設定 → **意識（Consciousness）** → 服務來源選 **「LM Studio」或「OpenAI Compatible」**：
- Base URL：`http://localhost:8080/v1`
- API Key：llama.cpp 不驗，填任意非空字串（如 `sk-local`）
- 模型：選 `/v1/models` 列出的 gguf 檔名
- 把角色的對話模型指到它；先在 AIRI 內建 Chat 打一句確認會回。

## 2. AIRI server channel（讓 bridge 連得上）

設定 → **連線（Connection）**：
- channel **隨 app 自動啟動、不需手動開**。
- **Expose On Network**：mirrored 模式下選 **「This device」即可**（WSL 仍連得到）。此模式下「Connect from Stage Pocket」QR 會顯示 unavailable，**用不到、忽略**。
- **Auth Token（重點眉角）**：
  - 欄位**清空會異常**（留空會自動重產）→ 不要刪到空。
  - 要設指定值：點欄位 → **Ctrl+A 全選 → 直接貼上覆蓋**（過程不經空白狀態）。
  - 這個 token **必須**與 bridge `.env` 的 `AIRI_AUTH_TOKEN` 完全一致；改完**重啟 AIRI**。
  - token 不符 → bridge 連上 ws 但被踢，server-sdk 報 `invalid token`。

## 3. TTS（讓它真的出聲）

設定 → **發聲（Speech）** → 服務來源選一個**本機** TTS：
- **Kokoro TTS（本機）**：最易上手，有「語音測試場」可當場試聽。**但 v0.10.2 的聲線可能只有英文**。
  - 只有英文聲線 → 設 bridge `.env` 的 **`ALERT_LANG=en`**，告警就以英文唸出（`scripts/mock-grafana.ts` 的 summary 也已英文化）。
- 要**繁中語音**：Microsoft/Azure 語音（雲端、需 key、會外送）或 Bilibili/IndexTTS（本地最強繁中，但要自架 vLLM server）。
- 選好 voice 後設為使用中。

## 4. bridge 的 .env

依 `.env.example` 填，重點欄位：

```
AIRI_WS_URL=ws://localhost:6121/ws     # mirrored 模式用 localhost
AIRI_AUTH_TOKEN=<與 AIRI 連線頁一致>
WEBHOOK_SECRET=<自訂一串隨機字串>
ALERT_LANG=en                          # 視 TTS 聲線語言；繁中聲線就用 zh
PORT=3001                              # 避開本機 Grafana 常用的 3000
```

## 5. 驗證

```bash
pnpm smoke    # 應印「已連上，狀態：ready」；角色對測試訊息有反應（沒設 TTS 則為文字）
pnpm dev      # 起 bridge（背景）
pnpm mock     # 另開終端：5 筆擬真告警 → 角色逐筆唸出
```

## 6. Grafana 端（用真實告警）

設定 → Alerting → Contact points → 新增 **Webhook**：
- URL：`http://localhost:3001/grafana/webhook`（Grafana 與 bridge 同機時）
- **Authorization Header**：scheme `Bearer`、credentials = `.env` 的 `WEBHOOK_SECRET`
- 按 **Test** → bridge 回 200、log 印出實際 body（**以它校正 `sources/grafana.ts`**）
- 建一條 alert rule 綁這個 contact point。

## 7. 疑難排解

| 症狀 | 可能原因 / 處置 |
|---|---|
| smoke 報 `invalid token` | AIRI 連線頁 token 與 `.env` `AIRI_AUTH_TOKEN` 不符；重設並重啟 AIRI |
| smoke 連線逾時 | 6121 連不到：AIRI 沒開、或非 mirrored 模式需改 hostname=0.0.0.0 + Windows host IP |
| 角色只有文字、不出聲 | AIRI 端 TTS 未設或未設為使用中 |
| TTS 唸繁中很怪 | Kokoro 只有英文聲線 → `ALERT_LANG=en`；要繁中改 Azure / IndexTTS |
| AIRI 隨機當掉/卡住 | GPU VRAM 被 LLM 榨乾（WebGPU 餓死）→ LLM 換更小量化（Q4_K_M） |
| 回應很慢 | 模型超出 VRAM 溢位到共享記憶體 → 換 Q4_K_M、降 `-c` ctx |
| Grafana Test 收不到 | bridge 的 `HOST` 綁太窄（Grafana 在別台時需 `0.0.0.0` 或內網 IP） |
| webhook 回 401 | Grafana 的 Authorization 憑證與 `WEBHOOK_SECRET` 不一致 |
