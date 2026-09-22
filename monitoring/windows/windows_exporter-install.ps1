#Requires -RunAsAdministrator
<#
  Augur 監控 — 在 Windows 主機安裝 windows_exporter（Prometheus 的效能 exporter）。
  Augur stack 的 Prometheus 會經 host.docker.internal:9182 抓取。

  用法（系統管理員 PowerShell）：
    powershell -ExecutionPolicy Bypass -File .\windows_exporter-install.ps1

  ⚠️ 這支腳本會做三件需要管理員權限、且不會自動復原的事：
     1. 從 GitHub 下載並**靜默安裝**一個 MSI；
     2. 在本機**註冊一個 Windows 服務**（windows_exporter）；
     3. **新增一條輸入方向的防火牆規則**（TCP 9182）。
     移除方式寫在檔尾。

  ⚠️ 版本是**釘住**的，不會每次去查最新版。
     latest 會讓「今天裝的」與「上週裝的」是不同的二進位，而兩者都自稱通過了同一份驗收。
     升版是一次明確的改動：改下面三個常數，並重新查證 SHA256。
#>
$ErrorActionPreference = 'Stop'

# --- 釘住的版本（查證來源與日期見 monitoring/README.md） ---
$version = '0.31.8'
$assetName = "windows_exporter-$version-amd64.msi"
# 取自該 release 的 sha256sums.txt
$expectedSha256 = '0aadce6afb20182b678bfca9e8f2e8464ef48c469b28b4cf02e99d82158f5d40'
$downloadUri = "https://github.com/prometheus-community/windows_exporter/releases/download/v$version/$assetName"

$port = 9182
# ⚠️ **不要放 `cs`。** 它在 windows_exporter v0.31.8 已經不存在
# （2026-09-22 實查該 tag 的 docs/：47 個 collector 裡沒有 collector.cs.md）。
# 指定一個不存在的 collector 會讓**服務起不來**，而 msiexec 仍然回 0 ——
# 於是腳本一路印到「完成」，Prometheus 的 windows target 卻永遠是 DOWN。
# 它原本提供的實體記憶體總量，現在由 `memory` collector 的
# `windows_memory_physical_total_bytes` 提供。
$collectors = 'cpu,logical_disk,memory,net,os,system,service'

$msi = Join-Path $env:TEMP $assetName
Write-Host "下載 $assetName（v$version，釘住的版本）…"
Invoke-WebRequest -Uri $downloadUri -OutFile $msi -UseBasicParsing

# 下載完先驗雜湊再執行。順序不能顛倒 —— 驗一個已經跑過的安裝檔沒有意義。
Write-Host '驗證 SHA256…'
$actual = (Get-FileHash -Path $msi -Algorithm SHA256).Hash
if ($actual -ne $expectedSha256.ToUpper()) {
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  throw "SHA256 不符！預期 $expectedSha256，實際 $actual。檔案已刪除，未安裝。"
}
Write-Host '  ✅ 雜湊相符'

Write-Host "安裝（collectors=$collectors，LISTEN_PORT=$port）…"
$margs = "/i `"$msi`" ENABLED_COLLECTORS=$collectors LISTEN_PORT=$port /qn /norestart"
$p = Start-Process msiexec.exe -ArgumentList $margs -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msiexec 失敗，ExitCode=$($p.ExitCode)" }

# 防火牆：**限縮到 Docker 的 host-gateway 網段**，不要對整個網路開。
# Prometheus 是從容器經 host.docker.internal 抓的，不需要讓網段上任何機器都讀得到 ——
# windows_exporter 的 /metrics 含服務清單、磁碟與網路介面資訊，那是主機的側寫資料。
Write-Host "開放防火牆 TCP $port（限 Docker/WSL 網段）…"
$ruleName = 'windows_exporter (Augur)'
$allowedRemote = @('172.16.0.0/12', '192.168.65.0/24', '127.0.0.1')
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  # 既有規則可能是舊版建立的「對全部來源開放」。就地收斂，不要當作已經好了。
  Write-Host '  規則已存在，更新來源限制…'
  $existing | Set-NetFirewallRule -RemoteAddress $allowedRemote | Out-Null
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
    -LocalPort $port -RemoteAddress $allowedRemote -Action Allow | Out-Null
}
Write-Host "  來源限制：$($allowedRemote -join ', ')"
Write-Host '  ⚠️ 若 Docker Desktop 使用的網段不在上面清單內，Prometheus 會抓不到；'
Write-Host '     用 `docker network inspect bridge` 查實際網段後補進 $allowedRemote。'

# ⚠️ **這個探測必須是致命的，不能只是 Warning。**
# msiexec 對「指定了不存在的 collector」一樣回 0，所以退出碼證明不了服務起得來。
# 原本探測失敗只印一行 Warning 然後腳本照樣印「完成」並 exit 0 ——
# 操作者以為裝好了，而 Prometheus 的 target 永遠 DOWN，要等到有人去看 Targets 頁才發現。
Write-Host '驗證 /metrics（失敗即視為安裝失敗）…'
$ok = $false
foreach ($attempt in 1..6) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/metrics" -UseBasicParsing -TimeoutSec 5
    if ($r.Content -match 'windows_cpu_time_total' -and $r.Content -match 'windows_memory_physical_total_bytes') {
      $ok = $true
      break
    }
    Write-Host "  第 $attempt 次：服務有回應但缺少預期指標，再試…"
  } catch {
    Write-Host "  第 $attempt 次：還連不上，再試…"
  }
}
if (-not $ok) {
  throw ("windows_exporter 裝了但 /metrics 沒有輸出預期指標。" +
    "最常見的原因是 ENABLED_COLLECTORS 裡有這個版本不存在的 collector —— " +
    "服務會起不來而 msiexec 仍回 0。用 ``Get-Service windows_exporter`` 與 " +
    "``Get-EventLog -LogName Application -Source windows_exporter -Newest 20`` 查原因。")
}
Write-Host '✅ windows_exporter 正常輸出指標（含 windows_memory_physical_total_bytes）'

Write-Host ''
Write-Host "完成。回到 WSL 確認：docker exec augur-prometheus wget -qO- http://host.docker.internal:$port/metrics | head"
Write-Host 'Prometheus(:9091) Targets 裡 windows-host 應變 UP。'
Write-Host ''
Write-Host '移除：'
Write-Host "  Get-Package 'windows_exporter*' | Uninstall-Package"
Write-Host "  Remove-NetFirewallRule -DisplayName '$ruleName'"
