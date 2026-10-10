## Project knowledge

This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Issue 與 PR 慣例(asp-ng 消費端)

- PR 描述包含:對應 issue(`Closes #<票號>`)、AC 逐條對照、做不到的逐條說明。
- commit 訊息用 Conventional Commits(`feat|fix|docs|refactor|test|chore|ci|perf|build|style`),由 `.asp/gate.sh` 的 commit-format 檢查。
- 本 repo 的測試指令是 `npm run test:unit`;型別、lint、建置與 e2e 由 `.github/workflows/ci.yml` 在每個 PR 上跑。
