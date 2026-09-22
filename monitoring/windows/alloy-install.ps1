#Requires -RunAsAdministrator
<#
  Augur 監控 — 在 Windows 主機安裝 Grafana Alloy，套用 alloy-config.alloy
  把 Windows Event Log 推到 Augur 的 Loki（http://localhost:3101）。

  用法（系統管理員 PowerShell，與 alloy-config.alloy 放同目錄）：
    powershell -ExecutionPolicy Bypass -File .\alloy-install.ps1

  ⚠️ 這支腳本會做兩件需要管理員權限、且不會自動復原的事：
     1. 從 GitHub 下載並**靜默安裝**一個 exe；
     2. 在本機**註冊一個 Windows 服務**（Alloy），並以 LocalSystem 執行
        —— 那是它讀得到 Security 事件日誌的原因，也代表它的權限很高。
     它**不**改防火牆（Alloy 是主動往外推，不需要 inbound）。
     移除方式寫在檔尾。

  ⚠️ 版本是**釘住**的，不會每次去查最新版。理由同 windows_exporter-install.ps1。
#>
$ErrorActionPreference = 'Stop'
$cfgSrc = Join-Path $PSScriptRoot 'alloy-config.alloy'
if (-not (Test-Path $cfgSrc)) { throw "找不到 $cfgSrc（請與本腳本放同目錄）" }

# --- 釘住的版本（查證來源與日期見 monitoring/README.md） ---
$version = '1.19.2'
$assetName = 'alloy-installer-windows-amd64.exe'
# 取自該 release 的 SHA256SUMS
$expectedSha256 = '72b19a3f547a4d21b6c617e0934a8471fbce4867e03f65f1b49a42d23d378e36'
$downloadUri = "https://github.com/grafana/alloy/releases/download/v$version/$assetName"

$dl = Join-Path $env:TEMP $assetName
Write-Host "下載 $assetName（v$version，釘住的版本）…"
Invoke-WebRequest -Uri $downloadUri -OutFile $dl -UseBasicParsing

Write-Host '驗證 SHA256…'
$actual = (Get-FileHash -Path $dl -Algorithm SHA256).Hash
if ($actual -ne $expectedSha256.ToUpper()) {
  Remove-Item $dl -Force -ErrorAction SilentlyContinue
  throw "SHA256 不符！預期 $expectedSha256，實際 $actual。檔案已刪除，未安裝。"
}
Write-Host '  ✅ 雜湊相符'

# 釘住版本之後，資產就是 exe 本身而不是 zip，原本的解壓分支不再需要。
Write-Host '靜默安裝 Alloy（會註冊為 Windows 服務，以 LocalSystem 執行）…'
Start-Process $dl -ArgumentList '/S' -Wait

$alloyDir = Join-Path $env:ProgramFiles 'GrafanaLabs\Alloy'
$cfgDst = Join-Path $alloyDir 'config.alloy'
Write-Host "套用設定 → $cfgDst"
Copy-Item -Path $cfgSrc -Destination $cfgDst -Force

Write-Host '重啟 Alloy 服務…'
Restart-Service -Name 'Alloy' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-Service -Name 'Alloy' | Format-Table -AutoSize

Write-Host ''
Write-Host '完成。Alloy 會把 Windows Event Log 推到 http://localhost:3101（Augur Loki）。'
Write-Host '驗證：Grafana(:3002) → Explore → 選 Loki → 查 {job="windows-eventlog"}'
Write-Host 'Alloy 本機 UI（除錯）：http://localhost:12345'
Write-Host ''
Write-Host '移除：'
Write-Host '  & "$env:ProgramFiles\GrafanaLabs\Alloy\uninstall.exe" /S'
