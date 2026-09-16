#Requires -RunAsAdministrator
<#
  Augur 監控 — 在 Windows 主機安裝 windows_exporter（Prometheus 的效能 exporter）。
  Augur stack 的 Prometheus 會經 host.docker.internal:9182 抓取。

  用法（系統管理員 PowerShell）：
    powershell -ExecutionPolicy Bypass -File .\windows_exporter-install.ps1
#>
$ErrorActionPreference = 'Stop'
$port = 9182
$collectors = 'cpu,cs,logical_disk,memory,net,os,system,service'

Write-Host '查詢 windows_exporter 最新版本…'
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/prometheus-community/windows_exporter/releases/latest' -Headers @{ 'User-Agent' = 'augur' }
$asset = $rel.assets | Where-Object { $_.name -like '*amd64.msi' } | Select-Object -First 1
if (-not $asset) { throw '找不到 amd64 MSI 安裝檔' }

$msi = Join-Path $env:TEMP $asset.name
Write-Host "下載 $($asset.name) …"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi

Write-Host "安裝（collectors=$collectors，LISTEN_PORT=$port）…"
$margs = "/i `"$msi`" ENABLED_COLLECTORS=$collectors LISTEN_PORT=$port /qn /norestart"
$p = Start-Process msiexec.exe -ArgumentList $margs -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msiexec 失敗，ExitCode=$($p.ExitCode)" }

Write-Host "開放防火牆 TCP $port…"
if (-not (Get-NetFirewallRule -DisplayName 'windows_exporter (Augur)' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'windows_exporter (Augur)' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
}

Write-Host '驗證 /metrics…'
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest -Uri "http://localhost:$port/metrics" -UseBasicParsing -TimeoutSec 5
  if ($r.Content -match 'windows_cpu_time_total') {
    Write-Host '✅ windows_exporter 正常輸出指標'
  } else {
    Write-Warning '服務有起，但沒看到預期指標，請檢查 collectors。'
  }
} catch {
  Write-Warning "無法讀取 /metrics：$_（服務可能還在啟動，稍後再試 http://localhost:$port/metrics）"
}

Write-Host ''
Write-Host "完成。回到 WSL 確認：docker exec augur-prometheus wget -qO- http://host.docker.internal:$port/metrics | head"
Write-Host 'Grafana(:9091 Prometheus) Targets 裡 windows-host 應變 UP。'
