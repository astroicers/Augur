#Requires -RunAsAdministrator
<#
  Augur 監控 — 在 Windows 主機安裝 Grafana Alloy，套用 alloy-config.alloy
  把 Windows Event Log 推到 Augur 的 Loki（http://localhost:3101）。

  用法（系統管理員 PowerShell，與 alloy-config.alloy 放同目錄）：
    powershell -ExecutionPolicy Bypass -File .\alloy-install.ps1
#>
$ErrorActionPreference = 'Stop'
$cfgSrc = Join-Path $PSScriptRoot 'alloy-config.alloy'
if (-not (Test-Path $cfgSrc)) { throw "找不到 $cfgSrc（請與本腳本放同目錄）" }

Write-Host '查詢 Grafana Alloy 最新版本…'
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/grafana/alloy/releases/latest' -Headers @{ 'User-Agent' = 'augur' }
$asset = $rel.assets | Where-Object { $_.name -like 'alloy-installer-windows-amd64.exe*' } | Select-Object -First 1
if (-not $asset) { throw '找不到 Windows 安裝檔（alloy-installer-windows-amd64.exe*）' }

$dl = Join-Path $env:TEMP $asset.name
Write-Host "下載 $($asset.name) …"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dl

# release 通常是 .zip，內含安裝 exe。
if ($dl -like '*.zip') {
  Expand-Archive -Path $dl -DestinationPath (Join-Path $env:TEMP 'alloy-inst') -Force
  $dl = (Get-ChildItem (Join-Path $env:TEMP 'alloy-inst') -Filter 'alloy-installer*amd64.exe' -Recurse | Select-Object -First 1).FullName
}
if (-not $dl) { throw '解開後找不到安裝 exe' }

Write-Host '靜默安裝 Alloy（會註冊為 Windows 服務）…'
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
