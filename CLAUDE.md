# Augur — AI 行為設定

> ASP v5 | 讀取順序：本檔案 → `.asp-compiled-profile.md`（asp-compile 編譯產物，
> 檔頭列來源清單；不存在 → 依 `.ai_profile` 載入散文 profile 為 fallback）→ `~/.claude/CLAUDE.md`（user-level 鐵則）
> Profile 邏輯與 ASP skills 詳見 `~/.claude/asp/profiles/` 與 `~/.claude/skills/asp/`

## 專案說明

Grafana panel plugin `augur-mascot-panel`：2D 3x3 精靈圖吉祥物 + Web Speech 語音，把本面板的告警念出來。零後端（ADR-004，supersede ADR-001/002/003）。

## 特殊規則（選填，覆蓋 user-level 預設）

- This repository contains a Grafana plugin. You must Read @./.config/AGENTS/instructions.md before doing changes.
- **禁止手改 `.config/`**（由 @grafana/create-plugin 託管）。擴充一律走根層的 `tsconfig.json` / `eslint.config.mjs` / `jest.config.js` / `.prettierrc.js` / `playwright.config.ts` wrapper。手改 `.config/` 的後果不是「被覆寫」而是「靜默失效」——migration 全是 `if (!AST match) return` 的早退，改壞比對點就會被無聲 skip。
- 本專案**不使用**腳手架的根層 `docker-compose.yaml` 與 `provisioning/`（P2 已裁定不落地）；開發環境只有 `monitoring/` 一套，`npm run server` 指向它。`.config/docker-compose-base.yaml` 與 `.config/Dockerfile` 是刻意閒置的託管檔，不要 extends。
