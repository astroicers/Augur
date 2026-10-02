# 路線圖與計畫原文

> **這份文件存在的理由**：`docs/` 底下多份 handoff 與規格在引用「計畫 P3」「P5」「P6」，
> 而那份計畫只存在於本機 `~/.claude/plans/` 下一個未版控的檔案 ——
> **repo 的讀者拿不到被引用的原文**。凡是進版控的文件所引用的東西，都得在版控裡。
>
> 更要緊的是：那份計畫裡有一條與已 Accepted 的 ADR-004 **正面衝突**，
> 而衝突的兩造先前不在同一個地方，誰都看不出有矛盾。下面〈已裁定的衝突〉把兩造並列（2026-10-02 經 ADR 訂正裁定）。

## 階段與現況（2026-10-02）

| 階段 | 內容 | 現況 |
|---|---|---|
| P0 | 保護既有未版控資產 | ✅ `14a481d` |
| P1 | 寫 ADR-004 supersede ADR-001/002/003 | ✅ Accepted 2026-09-18，5 個 POC gate 全過 |
| P2 | 腳手架併入、`src/core/` 遷入、舊管線刪除 | ✅ |
| P3 | 開發環境（Grafana 升版、plugin 掛載、provisioned dashboard） | ✅（下方衝突項 2026-10-02 經 ADR-004 決策 7 訂正裁定為刪除） |
| P4 | plugin 實作（來源層、語音層、跨 panel 互動、`AvatarController`） | ✅ |
| P5 | sprite 素材 | **工具側 ✅、素材側未開工** —— 規格、SOP、SP-7 機械驗收、SP-V.1 盲測頁都就位；缺的是畫 |
| P6 | 文件 | ✅ 根 README / `src/README.md` / CHANGELOG 已對齊現況（2026-09-21） |

未完成項目在本檔〈未完成項目〉（2026-10-02 起；先前的逐條計畫 `docs/handoff/remaining-plan.md` 已退役）。

## 未完成項目

> **2026-10-02 自 `docs/handoff/remaining-plan.md` 遷入**（該檔已退役，見它的檔頭）。
> 遷移方式：一個 agent 逐項盤點原檔 91 項（43 已完成、7 已作廢附理由），另一個 agent 對盤點做對抗性查證，
> 補回漏列的 5 項、更正 11 處誤判，再扣掉 2026-10-02 那次 PR 已解決的四項（B3-1、B3-5、B4-2，以及引用改指向）。
> **引用一律用檔案路徑與章節名、commit 用標題** —— 原檔的行號錨點漂移到 22 處解析到錯的內容，那是它退役的原因。
> 編號沿用原檔，方便對照 git 歷史；D1 / D2 是 2026-10-02 對話中的裁定編號。

**已裁定**：D2 **先不上架公開 Grafana catalogue**（2026-10-02）—— 維持未簽署、以 `npm run package` 的 zip 自行安裝。
理由：素材未交付（截圖只能拍點陣），且送審會公開 repo，D1 的歷史問題要先處理。

### 卡在人

**素材**

> **暫定素材已上線（2026-10-02）**：專案主人指定的「藍鯨布偶裝的疲憊男孩」，由 `tools/sprite-gen/whale-boy.mjs`
> 程式生成、照規格錨點畫，`SPRITE-CHECK: PASS`（整條驗收鏈第一次對交付物執行）。它讓下列項目有圖可跑，
> 但**不取代**它們 —— B2-1～B2-6 仍是為正式素材而設。另有一題角色設定待裁定：這個男孩是暫定、
> 還是取代 `live2d-template-spec-v1.md` §7 與 SP-6.0 色票所定義的原角色。

- **B2-1　凍結比例** —— 凍結清單的數值在 docs/sprite/sprite-sheet-spec.md §2 都已到位，已廢除的兩項也已從 docs/sprite/production-sop.md 階段 1 劃掉。剩下的只是把規格檔頭「尚未凍結」改成「已凍結 YYYY-MM-DD」。凍結後改一個比例就是 18 格全部重畫，需要專案主人點頭；髮色（SP-0.8）屬可調的顏色，不擋凍結。
- **B2-2　自繪或委外、發包 brief** —— 要裁定自繪或委外，然後交出 brief：docs/sprite/production-sop.md 階段 2 的七項加 6b 硬數字，盲測固定每個非中央方向 10 題；不要求畫師交參數值。委外的話，書面著作權讓與或授權書的形式與歸檔位置要在發包時就約定好。這題就是 sprite-sheet-spec.md §10〈仍然開著〉的「master frame 由誰畫」。 **前置**：發包前必須先裁定 B7-5 髮色（現行色票照畫會被亮度夾制擋下）。
- **B2-3　分層原始檔、描邊變體、授權書歸檔** —— 三題一起裁：分層原始檔要不要進版控（SP-9.11；不進的話要在 docs/asset-provenance.md 註明存放位置與負責人，並寫明本 repo 無法單獨重建）；描邊走 SP-6.4 烘進（變體 A）還是 SP-6.7 執行期 drop-shadow（變體 B）；委外授權書放在哪。產製若用到生成式服務，要實讀其條款並逐字內嵌進版控（SP-9.5a/SP-9.6）。
- **B2-4　交付後跑機械驗收** —— 素材交付四項：src/img/sprite/ 下的兩張 PNG 與 sprite-manifest.json，以及 docs/sprite/SOURCE-PROMPTS.md。驗收：node tools/check-sprite-sheets.mjs exit 0、sentinel 消失；.sprite-check/ 下的逐格診斷表、洋紅診斷圖，以及 SP-7.9 的四張聯絡表都要產出並經人工複核。同一批素材也要重量描邊估計器的偏差（docs/ROADMAP.md〈measureStrokeWidths〉）。
- **B2-5　真素材的 SP-V.1 盲測** —— 用 tools/blind-test/（npm run blindtest）讀真的 directions sheet，門檻是整體 ≥85% 且任一方向不低於 60%。沒達標就把誤判的方向與被誤認成什麼回饋給畫師做局部修正，不得放行。這一關是人工測試，check-sprite-sheets.mjs 量不到。
- **B2-6　回填三個留白門檻** —— 第一批素材到貨後回填三個門檻：SP-7.1 格內不透明覆蓋率（起點 54.7%）與 SP-7.6 的 128px 眉線對比（暫定 0.25）目前只發 warn，校準後改成硬限；SP-7.8 pngquant 後的體積（每張 ≤900KB、合計 ≤1.2MB，以及 S=384 的退路）**已經是硬失敗**，要確認的是預算本身對真素材合不合理。改完拿交付素材重跑，必須仍然 exit 0。
- ~~**B2-7　SpriteController / spriteAssets**~~ ✅ **2026-10-02 完成**：四層（視線／表情／嘴型／眨眼）、SP-8.7 四條降級、SP-8.10 定速 fallback、SP-8.12 click 420ms、pending 加速眨眼；25 條測試、9 個關鍵行為反向驗證。開發環境 Grafana 實測：表情、視線、點擊反應都正確疊層。**仍未驗**：224px stage 上「游標壓在臉頰（離中心約 60px）視線不得甩開」—— `gazeDeadZonePx(224)` = 56，60px 已在 dead zone 外，這條驗收與公式本身矛盾，待裁定是改公式還是改驗收；18 格是否都被走到過的目視確認。
- ~~**B2-8　兩個 sprite URL 選項**~~ ✅ **2026-10-02 完成**：`directionsImgUrl` / `reactionsImgUrl`，空字串時用打包的圖，填外部 URL 時顯示「自訂圖，對齊未驗證」；三條路徑（留空、相對路徑、壞路徑降級）以單元測試覆蓋，尚未在真 Grafana 裡各跑一次。
- **B7-5　髮色亮度超出夾制（SP-0.8，角色設定）** —— SP-0.8：髮色主色 #C0D0E0 的相對亮度 0.617，超出 SP-6.2 上限 0.61（次要色 #D0D0E0 為 0.639）。建議維持色相、整體降 2–3%，改成 #BCCCDC 與 #C8C8D7。這是角色設定，留給人裁定。裁定後同步三處：SP-6.0 色票表、docs/sprite/sprite-manifest.example.json 的 colours.hair、live2d/_archive/live2d-template-spec-v1.md §7。
- **logo　替換腳手架 logo** —— `src/plugin.json` 的 `logos` 仍指向 create-plugin 的預設 `src/img/logo.svg`（`docs/asset-provenance.md` 也記「尚未替換」）。A1 退出版控後，原本「用 A1 衍生圖」的路已斷；新路徑是素材交付後由 master frame 裁一張、放在 `src/` 底下。卡在 B2-4。改 plugin.json 後要重啟 Grafana。

**授權與「什麼該公開」**
- **D1　A1 衍生 blob 是否從 main 歷史移除** —— main 可抵達的 24 個 commit 的 tree 仍含 `assets/a1-*`，且已推上 GitHub。移除＝改寫 `14a481d` 之後的全部 commit（71+ 個換 SHA）並 force-push main，屬破壞性操作、需逐次授權；GitHub 端還要另請 Support 清除。**先做便宜的那一步**：專案主人回想當初用的生成服務並實讀條款 —— 條款允許，改寫就不必做。
- **B3-3　輪換或作廢 WEBHOOK_SECRET** —— WEBHOOK_SECRET 曾進過 Grafana 容器環境與 provisioning 檔，要由人輪換，讓舊值失效。不論 B3-1 怎麼裁都要做；AI 不代處理，也不編輯 .env。 本次（2026-10-02）刪除 contactpoints 後它已無任何消費者，作廢即可。
- **B3-4　根目錄 `.env.example` 與 `docs/sample-grafana-firing.json` 的去留** —— 根 `.env.example` 全是已刪的 bridge/AIRI 設定（ADR-004 決策 7 拿它當 dormant 污染的反例）；`docs/sample-grafana-firing.json` 同屬舊架構。`monitoring/.env.example` 的 WEBHOOK_SECRET 三行已於 2026-10-02 隨 contactpoints 刪除拿掉。
- **B7-1　`.claude/settings.json` 移出版控** —— .claude/settings.json 仍在公開版控裡：deny 12 條、ask 12 條，另有三條 /home/ubuntu/.claude/asp/hooks/ 絕對路徑的 hook。移出前要先替 deny 規則與 ship-gate 找好著落，而且不能把 pretooluse-ship-gate.sh 直接搬到全域（其他 repo 沒有 .asp-test-result.json）。.claude/skills/ 下的 11 個專案資產不要一起移。這是「什麼該公開」的問題，需專案主人裁定。
- **B7-4　`.config/AGENTS/` 四個檔的去留** —— A4-7 已讀完 .config/AGENTS/ 四個檔（instructions.md、e2e-testing.md、skills/build-plugin.md、skills/validate-plugin.md）：沒有本機絕對路徑、沒有憑證，內容是腳手架帶進來的公開文件摘要，建議四個都留在公開版控。需專案主人一句裁定，因為屬「什麼該公開」。這份審查結論目前只寫在退役檔裡，搬移時要一起帶走。

**ADR-004 的下一次修訂**（2026-10-02 只授權了三處；以下同類、需另一次授權）
- **B4-1　〈待驗風險〉第 4 條改寫（不擴 Emotion）** —— docs/adr/ADR-004-grafana-panel-plugin-mascot.md〈待驗風險〉第 4 條仍寫「emotion.ts…需擴充」。這與 2026-09-18 的人類裁定相反：裁定是不擴 Emotion，改用可選的 setReaction?（見 commit「feat(avatar): AvatarController 新增 setReaction?…」）。需人類授權後，把這一條改寫成已裁定的結論並標日期。
- **B4-3　〈待驗風險〉編號重排** —— ADR-004〈待驗風險〉的編號仍是 1、6、2、3、4、5。授權後重排成連續編號，並逐一修正引用處：docs/sprite/sprite-sheet-spec.md 的〈待驗風險 4〉與〈待驗風險 6〉、src/avatar/AvatarController.ts 的註解、docs/handoff/P2-handoff.md。
- **B4-4　〈查不到〉補第 6 項** —— ADR-004 檔頭寫「6 項查不到」，正文〈查不到〉只列 5 項；第 6 項（Alerting rules 端點的穩定性）只存在於 gitignore 的 .asp-fact-check.md。授權後補上第 6 項，並引用 docs/measurements.md M-1 的實測：HTML 登入頁與 404 一樣被 reject，真正走 resolve 的是形狀不對的合法 JSON。 注意 A2-3 的更正：M-1 量的是 `fetch + .json()`，不是 `getBackendSrv().get()` 本身。
- **B4-5　Verification Evidence 加 180 天複查行** —— ADR-004 的 Verification Evidence 表頭加一行：「本表查證日 2026-09-16，逾 180 天須複查」。腳本側的提醒已在 tools/asp-test.sh，授權後讓提醒訊息指向這一行。
- **B4-6　回填〈待驗風險 6〉** —— 用 `docs/measurements.md` M-3 回填：pending 確實抵達 panel；alerting→pending 與 resolved 只播一次，等 A2-2 補完。（決策 7 的 src/core 行數已於 2026-10-02 的訂正中拿掉，這半條結案。）
- **B4-7　〈待驗風險 1〉@internal 風險已實際發生一次** —— ADR-004〈待驗風險 1〉（alertState 是 @internal）已經實際發生一次：12.3.x 的欄位叫 dashboardId，12.4.0 才改名 dashboardUID；修法是以公開的 data.request.dashboardUID 作後備（commit「fix(panel): Grafana 12.3.x 上靜默降級…」）。授權後把這次事件，以及 12.3.0 到 13.2.2 的相容實測，記進該條與 Verification Evidence。

**實機驗證**
- **B5-1　sandbox 下語音能否發聲（Windows 實機）** —— Frontend Sandbox 開啟時語音能不能用仍未驗，因為 headless 環境沒有聲線。需要在專案主人實際看 dashboard 的 Windows 11 / Chrome 上，用 SANDBOX_PLUGINS=augur-mascot-panel 開、關各跑一次 PocAlwaysFiring，記三件事：speechSynthesis 是否存在、getVoices() 筆數、有沒有聽到聲音。若 sandbox 下發不了聲要另做產品決定，因為官方建議開 sandbox。結果回填 ADR 需走 B4 的授權。
- **B5-2　windows_exporter + 真規則跑 G-ADR004-2b** —— Windows 側還沒裝 windows_exporter（9182 無 listener）。G-ADR004-2 只用合成規則 vector(1)>0 驗過，真實指標能不能走到 panel 還沒驗。需要主機持有者以管理員身分跑 monitoring/windows/windows_exporter-install.ps1，再讓 rules-perf.yml 的真規則觸發；provisioning 熱重載後要整頁重新載入（hasAlertRules latch）。驗收：真實 CPU 告警被吉祥物念出來。

### 不卡人（可直接做）

**開發環境**
- ~~**B3-2　開發環境的一次性清除（merge 後）**~~ ✅ **2026-10-02 完成**：PR #5 merge 後照 `monitoring/README.md`〈告警通知〉跑兩支 API DELETE（先政策樹 → 202、根 receiver 變 `empty`；再 contact point `augur_bridge_webhook` → 202）。驗收：`augur-bridge/webhook` 累計行數清除前 27,998、T+60s 27,999（Alertmanager 換設定前多一行，README 預告過）、T+180s 27,999 —— 兩次相同，停止累積。同日 main 的 CI e2e 在無 contactpoints/policies 的全新 volume 上全綠。

**文件收尾**
- **A0-1　P2-handoff 裡已廢除條款的殘留** —— docs/handoff/P2-handoff.md §三點六 還有三處把已廢除的 SP-2.6/SP-3.3/SP-5.3 寫成現行指示：〈進行中：可讀性實測〉整節、已裁定表的「產製路徑＝先跑可讀性實測再決定」、「規格（1169 行）」的過期行數。改法：三處都標「2026-09-20 廢除，見 sprite-sheet-spec.md〈可讀性實測：三輪，與它們證偽的東西〉」並拿掉行數；或判定 P2-handoff 整份一起退役。 另：`sprite-sheet-spec.md` §11 第 1 條的作廢標記後還接著一行沒劃線的「凍結後改不動，這是唯一不能省的前置實測。」，讀起來像現行指示。
- **A0-6　規格檔尾〈待人類決定〉逐條補狀態** —— docs/sprite/sprite-sheet-spec.md 檔尾〈待人類決定〉自規格 v1 以來沒更新過，六條已有答案卻沒有狀態標記：A1 出處（已退出版控）、setReaction?（已授權實作）、斗篷亮度、瀏海高度（SP-0.7 已裁定）、panel 版面重排（A3-5 已做）、情緒衰減（已實作）。這六條逐條標註並指向 §10〈已有答案〉；其餘四條（master frame 誰畫、分層原始檔進不進版控、生成服務條款、描邊變體）改指向 §10〈仍然開著〉。〈未決/未驗〉的 pending 轉換條目補一句指向 docs/measurements.md M-3。 先刪掉 §10〈仍然開著〉表內那行空行 —— 它讓第 3 到 6 項脫離表格。
- **A0-7　P2-handoff 每一節都要有狀態** —— docs/handoff/P2-handoff.md 還有幾節沒有狀態：§二〈.asp-fact-check.md 待新增列〉、§三〈Review 指出但仍需你裁定〉表（ps1 供應鏈與 e2e 誤連 3000 已修，settings.json 與 ADR〈查不到〉第 6 項仍開著）、〈覆蓋缺口〉與〈小決定〉兩表、§四〈P4 必須 POC 實測的四項〉。兩條路擇一：逐條補狀態並改指向新的追蹤處；或整份退役 —— 退役前要先把 §二〈.asp-fact-check.md 待新增列〉的四列併進「散落-3」，並更正檔頭「只剩兩件」的說法。
- **散落-2　「src/core 零修改」與「dedup forget 已作廢」已過期** —— src/core/ 已不是「273 行、零修改」：dedup.ts 在「fix(sources): 泛用 episode 被取代後，降級路徑會永久靜音」加了 forget()，在「fix(panel): 會讓面板永久靜音的三條路徑…」加了 setWindow()，現在 335 行。要改的有：README.md 的 src/core 列；docs/ARCHITECTURE.md 的 src/core 列、〈關鍵設計〉兩處「零修改」，以及過期的 tools 列；P2-handoff §四的「dedup forget 已作廢」改成「已因真實 bug 實作」。之後別再寫死行數。
- **散落-3　`.asp-fact-check.md` 補列** —— .asp-fact-check.md（本機、gitignore）在 2026-09-18 之後沒有新增任何列。以下幾件只寫在版控文件裡：CSP 結論（A0-5）、rules 端點四種失敗形狀（docs/measurements.md M-1）、pending 實測（M-3）、Grafana 12.3.0 到 13.2.2 的相容實測，以及 alertState 欄位在 12.4.0 改名（commit「fix(panel): Grafana 12.3.x 上靜默降級…」）。依 ASP 鐵則四補列，每列要有結論、一級來源與日期。 另補 P2-handoff §二〈待新增列〉的四列，以及 A2-3 更正後的 M-1 結論。新列用五欄格式（事實點／聲稱值／驗證來源／驗證結果／日期）。
- **asset　`docs/asset-provenance.md` 殘句與壞表格** —— 〈A1 出處調查〉末段仍寫「待專案主人回想服務」「在確認之前 A1 維持現狀（已在版控中）」，與同檔〈A1 已退出版控〉矛盾，標「2026-09-21 已被退出版控取代」。〈進版控的資產〉表的分隔列與資料列之間多一行空行，nami 與 logo.svg 兩列不會被渲染成表格。
- **B7-4-附　e2e-testing.md 教的 GRAFANA_VERSION 在本 repo 無效** —— .config/AGENTS/e2e-testing.md 教人用 GRAFANA_VERSION / GRAFANA_IMAGE 跑 npm run server，以驗最低或最新版本。但本 repo 的 npm run server 指向 monitoring/docker-compose.yml，tag 寫死；那兩個變數只對刻意閒置的 .config/docker-compose-base.yaml 有效。照做會靜默跑在 13.2.2 上，得到一個假通過。.config/ 不能改，所以在根 README 或 tests/ 的註解寫明正確作法（12.3.x 那次的隔離 compose 實跑見 commit「fix(panel): Grafana 12.3.x 上靜默降級…」）。
- **A4-3　plugin.json metadata** —— D2 已裁定**先不上架**（2026-10-02），`info.links` 不再是必要項。仍可做：description 寫的「2D sprite mascot」在素材交付前是診斷點陣，與 `src/README.md` Status 段對齊。改 plugin.json 要重啟 Grafana。

**量測**
- **A2-1　POC dashboard 的非預設選項** —— monitoring/grafana/provisioning/dashboards/augur-poc.json 的 panel 3 仍是 repeatFiringMin: 0，live 環境沒有任何 panel 走 repeatFiringMin 的重播路徑；這個路徑目前只有單元測試覆蓋。設成 1，並確認不干擾 docs/measurements.md M-3 的觀察方式與 tests/panel-speaks.spec.ts；若決定不設，就把理由寫下來。 原計畫也要求 panel 1 至少一欄刻意非預設（用來分辨換選項成功與否），現在 panel 1 六欄全是預設值；要嘛補，要嘛寫明由 panel 5 承擔。
- **A2-2　pending 轉換逐秒觀察的 (b)(c)** —— docs/measurements.md M-3 只答了 (a)。(b) alerting→pending 回落：先查 Grafana 的告警狀態機到底有沒有這個轉換；沒有就標為不可達並結案，有就加一條會回落的規則實測。(c) resolved 是否準時且只播一次：改用 enableTTS:false，直接計 feed 的 DOM 節點數重量。M-3 的 harness 不在版控，重量時一併放進 tools/。結論交給 B4-6 回填 ADR。
- **A2-3　更正 M-1 對 getBackendSrv() 的結論** —— panel 層四種失敗形狀的降級結論不變；但 `docs/measurements.md` M-1 量的是替代原語 `fetch + .json()`，不是 `getBackendSrv().get()` 本身。依 Grafana 13.2.2 前端原始碼，responseType 由 content-type 決定，非 JSON 的 200 回應會 **resolve 成原始字串**。更正 M-1，或在 live panel 內直接呼叫實測。
- **A2-4　WebKit 跨格滲色** —— docs/measurements.md M-2 只量了 Firefox，WebKit 還沒量。本機補量需要 sudo npx playwright install-deps webkit；也可以改在 CI 的 ubuntu-latest 上用 npx playwright install --with-deps webkit 跑，不必動本機系統。當初的 harness 從未 commit，要重建進 tools/，保留 299% 對照組與全紅健全性檢查。量完回填 docs/sprite/sprite-sheet-spec.md 的 SP-1.18 與 §11 第 2 條。
- **A5-2　CI 的紅燈路徑從未實測** —— GitHub Actions 至今 48 筆全部 success，從沒紅過 —— 「會不會紅」未經驗證。推一支一次性分支、刻意放一個 typecheck 錯誤，確認 CI 變紅且失敗步驟是 typecheck，然後刪掉該分支。不驗的話在 ci.yml 檔頭寫明「紅燈路徑未實測」。

**程式**
- **B7-2　遠端聲線切段（ADR-004 決策 4）** —— src/speech/speaker.ts 只做到偏好本機聲線，沒有切段。ADR-004 決策 4（Accepted）明文要求「偵測到遠端聲線（localService===false）時才切段」。照 ADR 實作：遠端聲線依 CHARS_PER_SEC 切成每段 ≤10 秒逐段 enqueue，本機聲線不切；單元測試注入 localService 為 true 與 false 兩組，並同步 tools/asp-test.sh 的 MIN_TESTS。若改判不做，就變成要改 ADR 文字，那需要人裁。
- **B7-3　視線 idle 4 秒回中央 + pointerleave** —— src/components/MascotPanel.tsx 的互動 effect 沒有 idle timer，也沒有 pointerleave。要做的是：每次 pointermove 重設一個 4 秒 timer，到期或 pointerleave 時 setGaze(CENTER_CELL) 並同步 gazeRef，cleanup 時 clearTimeout；配假計時器測試，並同步 MIN_TESTS。PR 描述裡單獨請一句確認「4 秒」這個數字。完成後更新 sprite-sheet-spec.md §10〈仍然開著〉第 3 項。
- **B7-6　情緒衰減 3 分鐘 vs 告警翻轉週期** —— EMOTION_DECAY_MS 是 3 分鐘，比 PocFlapping 的 2 分鐘週期長，結果 pending 表情只在第一個週期出現。docs/measurements.md M-3 已列三個選項並建議「接受」，只是還沒拍板。把建議改寫成裁定，並把回看條件綁在 B2-5：素材交付後若 pending 那一格幾乎看不到，就重新打開。sprite-sheet-spec.md §10〈已有答案〉第 7 項要同步改指向。
- **附錄-7　跨 panel 能力偵測改成可恢復** —— src/components/MascotPanel.tsx 只在 mount 時呼叫一次 probeDashboardDom（src/dom/dashboardPanels.ts），一旦降級就永不重試；例如 mount 當下只看得到一個 panel，就會永久停在「限本 panel」。改成可恢復時，必須同時重綁 listener 的 target（document 或 host），否則 chip 顯示全頁追蹤、事件卻仍只來自自己的容器。測試要把 panel render 在 [data-viz-panel-key] 容器內，並斷言升回後在別的 panel 座標派發 pointermove 會改變 gaze。


## 計畫原文（被引用的段落，逐字）

### P3 — 開發環境

> 改 `monitoring/docker-compose.yml`：
> - Grafana **11.4.0 → 13.2.x**。
> - 新增 volume 把 `dist/` 掛到 `/var/lib/grafana/plugins/augur-mascot-panel`。
> - 新增 `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=augur-mascot-panel`。
> - **補一個 provisioned dashboard**（`provisioning/dashboards/`，目前零個）——
>   沒有 dashboard 就無從測「點擊偵測」。
> - **丟** `alerting/contactpoints.yml` 與 `policies.yml`（指向已不存在的 :3001 bridge）。
> - **留** `rules-perf.yml`（CPU 85% / Mem 10% / Disk 10%）與 `rules-security.yml`（5 條 Loki 規則）
>   —— 它們正是 `alertState` 的來源，也是現成的 threshold 參考。

前四條已完成。第五條曾與 ADR-004 衝突，**2026-10-02 經 ADR-004 決策 7 的訂正裁定後執行** —— 見下。

### P5 — sprite 素材

> - **內容大綱已經有人寫好**：`live2d/_archive/live2d-template-spec-v1.md:103-113` §6 定義了
>   calm/warning/critical/resolved 四個表情的視覺語意（汗滴、陰影、怒氣符號、閃光）。
>   直接當 9 格反應圖的大綱（4 格表情 + idle/眨眼/講話/追視左右）。
> - 現有 `emotion.ts` 只有 4 個 emotion，吃不滿 9 格 → 需擴充，它是骨架不是成品。
> - 風格參考：`assets/layers/` 的 7 張 full-canvas 同錨點分層（Augur 銀藍占卜師）。

⚠️ **這三條都已被後續裁定取代或作廢**：

1. 「9 格 = 4 格表情 + idle/眨眼/講話/追視左右」被四層疊合架構取代 ——
   現在是 **18 格**（directions 9 + reactions 9），語意見規格 §3 / §4。
2. 「`emotion.ts` 需擴充」被 2026-09-18 的人類裁定**否決** ——
   改用 `AvatarController.setReaction?()` 承接 click / pending，
   理由是它們不是 severity 的函數，擴充會污染 `severityToEmotion` 的純函式語意。
3. 「風格參考 `assets/layers/`」**該目錄已於 2026-09-21 退出版控**（出處不可考）。
   替代品是 `live2d-template-spec-v1.md` §7 的文字描述 + 規格 SP-6.0 的色票表。

### P6 — 文件

> 重寫根 `README.md`（**現在還在講 AIRI 與 `pnpm smoke`，已過期一輪，這次不要再欠**）
> 與 `docs/ARCHITECTURE.md`（資料流圖整份作廢）。修正安裝說明為 `dist/` 掛載。

已完成，並於 2026-09-21 再對齊一次現況。

## 已裁定的衝突：`monitoring/` 的 contactpoints / policies

> **【2026-10-02 裁定，經 PR 送審，merge 即為授權】採下方解 1。** 兩檔刪除；ADR-004 決策 7 補一段訂正，
> 明定「`monitoring/` 全套保留」不含已失效的 bridge 告警投遞設定。
> 執行時多查到一件事：**只刪檔不會清掉既有 `grafana-data` volume 裡已 provision 的殘留**，
> 一次性清除步驟在 `monitoring/README.md`〈告警通知〉。
> 以下保留裁定前的原文，作為這個衝突怎麼被看見、怎麼被解掉的記錄。

**兩造逐字並列**：

| 來源 | 原文 | 效力 |
|---|---|---|
| **ADR-004 決策 7**（裁定前原文；2026-10-02 訂正前位於 `docs/adr/ADR-004-grafana-panel-plugin-mascot.md` 決策 7 的「保留」條（行號已因訂正位移，以章節為準）） | 「**保留**：`src/core/*`… 與其 4 支測試；**`monitoring/` 全套**（升 Grafana 13.2.x、加 plugin 掛載、補 provisioned dashboard）。」 | **Accepted**（2026-09-18，經人類授權） |
| **計畫 P3** | 「**丟** `alerting/contactpoints.yml` 與 `policies.yml`（指向已不存在的 :3001 bridge）。」 | 計畫，未經 ADR 程序 |

**裁定前的現況（2026-09-21）**：兩個檔**都還在**，而 `contactpoints.yml:11` 逐字是
`url: http://host.docker.internal:3001/grafana/webhook` —— 那個 bridge 已於 `fbd81f4` 刪除。
所以它現在是一個**指向不存在服務的 webhook 設定**。

**為什麼不自行裁定**：ADR 的效力高於計畫。「全套保留」是 Accepted 的文字，
要改它需要走 ADR 修訂，而那需要人類顯式授權（2026-10-02 經 PR 完成，見本節開頭）。
在那之前自行刪除等於讓計畫覆寫 ADR，那會讓 ADR 的狀態值失去意義。

**三條可能的解**（2026-10-02 採 1；其餘追蹤見 `docs/ROADMAP.md`〈未完成項目〉）：

1. **刪掉兩個檔**，並在 ADR-004 補一行說明「全套保留」不含已失效的 bridge 設定。
2. **留著但改成無害**：把 webhook URL 換成一個明確的佔位（例如 `http://localhost:1/disabled`）
   並在檔頭標明它是歷史遺留、目前不通往任何地方。
3. **留著不動**，接受 `monitoring/` 裡有一份指向死服務的設定。

另外還有一件**與裁定無關、但不該一起拖著**的事：`WEBHOOK_SECRET`
曾出現在容器環境變數與 provisioning 檔裡。**那應該由人輪換**，不論上面選哪一條。
AI 不編輯 `.env`。

## 未解決：`measureStrokeWidths` 的重寫，卡在「沒有有效的測試台」

**現況**：`tools/lib/spriteChecks.mjs` 的 `measureStrokeWidths` 仍是「描邊帶面積 ÷ 剪影周長」。
2026-09-22 的對抗性複審對它提出三條實質指控（都附了量測）：

| 指控 | 複審量到的數字 |
|---|---|
| 內／外描邊兩種畫法在同一剪影上差 **2.31 px**，比整個容差窗 2.048 px 還寬 | 內 7.479 / 外 9.792 |
| 四條普通髮束（SP-2.3 合法）把真值 8.192 稀釋成 9.505 | 超出容差 |
| 1px 填色滲出（手繪 lineart-over-fill 的常態）讓環狀 flood 找不到種子 → **NaN 硬紅** | 舊實作 8.505 clean |

同日跑了一輪五設計 × 五評審的重設計工作流。結論是採用「沿剪影局部法線的逐邊界像素游程
＋直方圖眾數（不做周長正規化）」，實作簡報完整、每個常數都有出處。

**但它沒有落地，理由是我無法驗證它。** 實作完之後對照量測：

| 案例 | 新（法線游程） | 舊（面積÷周長） |
|---|---|---|
| 抗鋸齒基準（SP-2.14 下限 2px） | 7.864 通過 | 8.525 通過 |
| 相鄰 `#777777` 同亮度衣物 | 7.864 通過 | **8.525 通過** |
| 填色滲出 1px | 8.867 通過 | **8.680 通過** |
| 填色滲出 2px | 9.856 **紅** | 9.009 通過 |
| 四種一次上 | 9.856 **紅** | 9.009 通過 |

**在我建得出來的 fixture 上，新的比舊的差**（滲出 2px 與四合一都是回歸）。
更關鍵的是最後兩欄：舊實作在「同亮度衣物」讀 8.525 而不是複審說的 17.132，
在「滲出 1px」讀 8.680 而不是複審說的 NaN ——
**我的測試台一個原始失效案例都沒重現出來**，所以我沒有立場判斷改寫是不是改善。
按「量不到改善就不上」的原則退回，改寫的程式碼沒有保留。

**真正的 blocker 因此不是演算法，是 fixture。** `tools/lib/syntheticSheet.mjs` 畫的是
硬邊、平塗、1-bit alpha 的幾何人偶（1-bit 本身就違反 SP-2.14）。要評估任何描邊估計器，
測試台必須先能重現那三條指控，也就是至少要支援：
`strokeInside`、`fillBleedPx`、`inBandGarment`（讓帶內色**真的貼著**描邊，
複審的版本貼了 45% 周長）、`strands`、`alphaRampPx`（以真實邊界為中心的對稱斜坡 ——
單向往外加半透明像素會把剪影放大、每條游程系統性長 1.5px，我第一版就是這樣錯的）、
`matte`、`strokeColour`、`strokeGapY`、`perCellStrokePx`。

**【2026-09-26 更新：fixture 做好了，四條指控重現了兩條】**

`syntheticSheet.mjs` 的 `buildSheets(opts)` 現在支援 `strokeInside` / `fillBleedPx` /
`strands` / `alphaRampPx` / `matte` / `strokeColour` / `strokeGapY` /
`perCellStrokePx` / `inBandGarment`（預設值一律維持舊行為）。
alpha 漸層是**以真實邊界為中心**的對稱斜坡 —— 單向往外加會把剪影放大、
每條游程系統性變長，我第一次寫就是這樣錯的。

對現行 area÷perimeter 估計器實測（真值 8.192，容差 ±1.024）：

| 案例 | 量到 | 判定 |
|---|---|---|
| 基準 / 抗鋸齒 2px | 8.525 | 通過 |
| 內描邊 | 8.297 | 通過 —— 兩種畫法只差 **0.23px**，不是複審說的 2.31 |
| 填色滲出 1px / 3px | 8.598 / 8.854 | 通過 —— **不是 NaN** |
| **同亮度衣物 `#7c7c7c`** | **17.132** | **紅** ← 重現，與複審數字完全相同 |
| **四根漸細髮束** | **9.708** | **紅** ← 重現 |
| 真的畫錯 4px / 12px | 4.120 / 12.567 | 紅 ✓（鑑別力還在） |

**同亮度衣物那條已修**：SP-6.4 把 `#6E7681` 只列為參考色、規範的是亮度帶，
於是檢查沒有東西可以分辨「描邊」與「剛好同亮度的合法衣物」。
改成讓描邊色成為 manifest 的宣告值（`stroke.colour` + `stroke.colourToleranceRgb`，
預設取 SP-6.4 的參考色），亮度帶保留為第一道篩、顏色是第二道。
17.132 → 8.525，與乾淨基準完全相同。參考色由**完全不透明**的像素取，
不從最外圈取 —— 抗鋸齒讓最外圈是混色。

**四根髮束那條沒修。** 機制與複審描述的**相反**：我的 fixture 上它讓估計值偏**高**
（9.708 > 8.192），因為細髮束兩側的描邊會合併、描邊面積相對周長偏大；
複審描述的是偏低。我試過用形態學開運算排除細長特徵的周長，結果讓基準從
8.525 惡化到 9.070（吃掉 86% 容差預算）而髮束變成 11.068 —— 方向就是反的，已退回。
要修它需要的是工作流設計的**逐法線游程**而不是 area÷perimeter，
而那個 380 行改寫我仍然無法在現有證據下證明是改善。

**【2026-09-27 更新：換掉了。共用電池 15/20 → 20/20】**

`tools/stroke-battery.mjs`（20 列、兩個方向都要對）現在是共用的計分板 ——
上一輪失敗的唯一原因就是沒有它。舊的 area÷perimeter 實作：**15 / 20**，
錯的是 F/G（髮束 9.708）、L/M（matte → NaN）、S（窗內邊緣 9.0px → 9.426）。

新實作（法線游程 + 眾數統計 + sRGB→線性查表）：**20 / 20**，
selftest 126 / 126 零回歸，完整閘門全綠，9 格 172 ms，**沒有動任何 severity 或門檻**。
五列誤紅全部修掉。

**這份程式碼的來歷必須誠實記下來。** 重跑的設計比較工作流在驗證階段前失敗
（7 個 agent 有 5 個停滯），但其中一個 agent **把實作留在追蹤檔裡當殘留**、
而它的報告從未回來。我先自己照另一個設計的演算法重寫了一遍，只拿到 18/20；
發現工作樹有 423 行不是我改的東西之後才回頭查 —— 那份殘留在電池上跑 20/20。
我已經把它 `git checkout` 掉了，靠 `git fsck --lost-found` 從 dangling blob
（`83d8135`，95,867 bytes）救回來的。

**所以：這 390 行是我用量測驗證的，不是逐行讀過的。** 我驗了：
電池 20/20、selftest 126/126、閘門全綠、172ms、沒改任何 severity/門檻、
而且真實寬度 3→16px 的掃描顯示它確實在追蹤（不是回一個接近宣告值的數字）。
**但它需要一次 read-through。**

**已量到的系統性偏差**：在宣告值 8.192 上讀 7.553，**−0.639 px（吃掉 62% 的容差預算）**；
3–16px 全域都是 −0.3 到 −0.8 的負偏差。舊實作是 +0.333（33%）。
兩個都不是無偏的。**刻意不校正** —— 對著合成 fixture 減掉一個 offset
正好是「調到 fixture 上」那個陷阱，而合成 fixture 不是真實畫稿。
第一批真素材到貨時要重量這個偏差，再決定是校正還是放寬容差。

**【2026-09-27 續：SP-2.14 的檢查補上了，而它推翻了上面那個 20/20】**

`tools/` 先前完全沒有 SP-2.14（禁 1-bit 硬邊）的機械承接，而那不只是「少一條檢查」——
合成基準畫的就是 1-bit（實測整格只有 2 個 alpha 值、**零個**半透明像素），
所以**整個閘門是對著一張規格自己會退的圖校準的**。

補上檢查（量測法：半透明像素數 ÷ 剪影周長 = 平均過渡寬度；實測 `比值 = 2h − 1`，
0px→0.00、1px→1.00、2px→3.00，分離很乾淨），並把 fixture 的**預設改成 2px 羽化**。

**把基準改成合規之後，四條先前看不見的誤紅立刻現形 —— 其中兩條是我自己寫的：**

| 誤紅 | 原因 |
|---|---|
| `SP-7.1/預乘alpha` | 我用 `max(RGB) ≤ alpha` 當預乘指紋。它在一個 fixture 上分得乾淨（0% vs 100%），但**不通用**：任何比 alpha 暗的顏色都滿足它，於是線稿色（近黑）的覆蓋格讀 100% 而它是直通的。改用 SP-2.15 的可驗證後果 —— 半透明像素與最近不透明像素的 RGB 殘差中位數（直通 0，黑/白 matte 64/72） |
| `SP-7.4/眨眼半透明` | 侵蝕深度用宣告的 `featherS`（SP-2.14 的**下限**），而 4px 羽化同樣合規 —— 固定 2px 對它永遠不夠。合規素材讀 96.9%/94.5%（2px）到 81.4%/71.3%（4px），全部誤紅。改成量出這塊自己的過渡寬度再侵蝕。**這條門檻我上一次「修好」時就是對著 1-bit 校準的** |
| `SP-6.6/皮膚遮罩` | skin mask 用 `alpha >= 128` 收集，而 2px 羽化的最外圈是 alpha 64 —— 遮罩比真實皮膚內縮，而上限是 **0 個**越界像素。複審在真實畫稿上量到內縮 2–3.3px。按 SP-2.14 的羽化寬度膨脹回去 |

**⚠️ 而且它推翻了上一節的 20/20。** 那個數字是在 **1-bit 素材**上量的；
基準改成合規之後，新估計器是 **19 / 20** —— 失敗的是 R 列（真值 7.4px 讀 6.716）。
原因正是那個已記錄的 **−0.639px 系統性偏差**：7.4 − 0.64 ≈ 6.76，
一個落在宣告窗（7.168–9.216）內的合法寬度被推出窗外。
（舊的 area÷perimeter 實作在合規基準上是 15/20，所以換代仍然是明確的改善。）

**偏差仍然刻意不校正** —— 對著合成 fixture 減 offset 正好是「調到 fixture 上」那個陷阱。
第一批真素材到貨時重量，再決定校正還是放寬容差。R 列現在就是那個決定的證據。

**【2026-09-29 更新：偏差翻案 —— 大頭是 fixture 自己畫錯，R 列已修，20/20】**

上兩節的「−0.639px 系統性偏差」拆開來是兩件事，先前全記在估計器頭上：

1. **fixture 的斜坡相位錯了半格（~0.5px，大頭）。** `applyAlphaRamp` 的 α 公式
   以邊界**像素中心**為零點，而幾何邊界在該像素**外緣**（+0.5px）——
   每條羽化邊的覆蓋積分淨損 ~0.5px。h=2 的剖面實測 `0,64,128,191,255`：
   積分 7.50px 而 fixture 宣稱 8.192。**「7.4px 的 R 列」實際只畫出 ~6.9px，
   誤紅的是圖不是尺。** 改成守恆斜坡（邊界線為中心、像素區間取平均）之後，
   估計器一行沒改，電池 19/20 → **20/20**，`KNOWN_FAIL` 清空。
   「刻意不校正偏差」那個決定因此**不再需要做**——偏差的大頭不存在了。
2. **估計器的內緣硬分類（~0.3px，合成圖上量不到）。** 只有外緣是次像素，
   內緣（描邊↔填色）走顏色硬門檻，每條游程系統性少半個像素，且少多少
   **隨填色顏色變**（這正是獨立複審量到 −0.29 與 0.694px 擺動的機制）。
   已補內緣解混；8× supersample 解析地面真值（含內緣真實混色）：
   修正前 −0.31 ~ −0.34、修正後 **+0.03 ~ +0.08**，填色擺動 0.017px。

副作用與殘留，誠實記：
- 換守恆斜坡讓 SP-2.14 的「數半透明像素」法**失去 h<2 的鑑別力**
  （h=1 與 h=2 的半透明像素一樣多），已換成一階矩統計量（相位無關）。
- ~~合成 fixture 仍有 ~−0.2 殘餘偏差，來源未定位；R 列餘裕只剩 0.002px~~
  **【2026-10-01 已定位並修正】** 第三次「fixture 畫不出它宣稱的東西」：
  描邊從核心**像素中心**量距，而幾何邊緣在中心之外，真實寬比宣告窄 ~0.21px。
  拆解方法：同一個精確寬度的解析圓環，外緣用 fixture 的斜坡畫 → 估計器 +0.02~+0.07；
  所以 fixture 上的 −0.18 只能是圖本身窄。改成對解析輪廓（頭橢圓 ∪ 身體梯形）
  量精確距離之後，**估計器一行沒改**：B 列 −0.183 → +0.031、R 列餘裕 0.002 → 0.374。
  並加了 selftest [2c]：沿解析法線對渲染像素積分的**獨立尺**，不經估計器量 fixture
  自己畫多寬 —— 改回舊畫法時恰好紅這三條、其餘 153 條全綠，也就是說在它之前
  整個 repo 沒有任何東西會發現 fixture 窄了（估計器與 fixture 互相校準是循環論證）。
- 近色填色（#7c7c7c 整片貼內緣）殘餘 +0.42px —— 混色像素被顏色門檻
  直接判成描邊，解混救不到；顏色分不開時內緣本來就不可分辨。
- 電池自 2026-09-28 起**是閘門**（退出碼 + asp-test.sh + CI + KNOWN_FAIL 逐列 pin）。
  在那之前它只印不判：實測把估計器換成回傳定值的樁，19/20 崩到 5/20 仍回 0。
  上一節「改估計器時先跑這支」的規則先前沒有任何機械承接。

## ⚠️ 引用 commit SHA 這件事已經出過一次錯

2026-09-22 的複審發現：本 repo 的四份文件共五處引用 **`d428af1`**，而**那個 commit 不存在**。
`git cat-file -t d428af1` → `fatal: Not a valid object name`。
真正刪掉舊管線的是 **`fbd81f4`**（已全部更正）。

**來歷**：`d428af1` 是 nami 美術那次 `filter-branch` **之前**的 SHA。
改寫歷史讓分支上每個 commit 的 SHA 都變了，而文件裡的引用沒人回去更新 ——
**而且過了好幾天都沒有人發現**，因為沒有任何機械檢查會去驗一個 SHA 解不解得開。

**這直接關係到還沒做的另一次歷史改寫**：把 `assets/` 的 A1 衍生素材從分支的
24 個 commit 的 tree 裡移除（現況是「不再提供」而不是「拿掉」）。
同一件事會再發生一次 —— 分支上每個 commit 的 SHA 都會變。要做的話，改寫**之後**
必須逐一重映文件裡的 SHA，或者乾脆改成引用 commit 標題而不是 SHA。

> ⚠️ **這一段原本用「先前執行計畫的某編號前置」指向那次改寫的決策。那個引用解不開** ——
> 該計畫裡沒有那個編號，而相近的編號解析到的是一個**已完成**、跟歷史改寫無關的項目。
> 比純粹的斷鏈更糟：它會**默默解析到錯的東西**。那次改寫的決策現在追蹤在本檔〈未完成項目〉的 D1。

## 相關文件

| 文件 | 內容 |
|---|---|
| `docs/adr/ADR-004-grafana-panel-plugin-mascot.md` | 決策權威。與本檔衝突時**以 ADR 為準**。 |
| `docs/handoff/remaining-plan.md` | **已退役（2026-10-02）**。仍有效的項目已遷入本檔〈未完成項目〉；保留為歷史 |
| `docs/sprite/sprite-sheet-spec.md` | 精靈圖規格。發包給畫師時給這份 + `production-sop.md` + `sprite-manifest.example.json`。 |
| `docs/asset-provenance.md` | 美術資產的出處與授權；含 A1 退出版控的完整記錄 |
| `docs/dependency-audit.md` | `npm audit` 的 8 筆命中為什麼不修 |
