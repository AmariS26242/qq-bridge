@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem The path reaches PowerShell through an environment variable: the apostrophe in the
rem user name (O'Example) makes '%~dp0' expand to '<user-profile>\...\', which closes
rem the single-quoted string early ("The string is missing the terminator: '.") and
rem silently skipped the whole kill step - so this "restart" never restarted anything.
set "QQBRIDGE_DIR=%~dp0"
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
rem 注意：start.bat 是以**相对路径**启动的（node src/bridge.js），所以
rem Win32_Process.CommandLine 里根本不含仓库绝对路径 —— 旧版按
rem '*%~dp0src\bridge.js*' 匹配永远匹配不上，于是「重启」只是又起了一个实例，
rem 旧桥接继续跑（state/bridge.log 里 04:54 出现过两个实例同时加入 DSH 事件流，
rem 只因控制台端口冲突才被挡下，其中一个还把 social-v2.json 用旧快照覆盖了回去）。
rem 这里改成按 PID（读锁文件）+ 按 *bridge.js* 兜底两条路一起杀。
powershell -NoProfile -Command "$lock = Join-Path $env:QQBRIDGE_DIR 'state\bridge.lock'; $pids = @(); if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\d+$') { $pids += [int]$raw } }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' } | ForEach-Object { $pids += $_.ProcessId }; $pids | Sort-Object -Unique | ForEach-Object { Write-Host ('  kill PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
rem 等旧实例真的退出（并放开控制台端口）再删锁；否则「锁删了但进程还活着」就是双实例。
rem 用 ping 而不是 timeout：本文件常被 `cmd /c restart.bat > log` 调用，stdin 被重定向时
rem timeout 会直接报 "Input redirection is not supported" 并跳过等待（等于没等）。
ping -n 4 127.0.0.1 >nul
powershell -NoProfile -Command "$live = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }; if ($live) { Write-Host '仍有桥接进程存活：'; $live | ForEach-Object { Write-Host ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }; exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo.
    echo 重启已中止：避免出现双实例互相抢消息、互相覆盖 state。
    echo 请手动结束上面列出的 PID 后重试。
    pause
    exit /b 1
)
del state\bridge.lock 2>nul
rem Start the guard with no window at all: not `start "" cmd /c start.bat` any more,
rem which put a new visible cmd window on the desktop on every restart. run-hidden.vbs
rem has wscript create the process with SW_HIDE, so the window never exists.
rem The cmd it starts still carries start.bat in its command line, so the "stop old
rem guard" step above keeps finding it; its output goes to state\guard.log (that text
rem used to live only in the visible window).
wscript.exe //B //Nologo "%~dp0run-hidden.vbs" start.bat
echo Guard started in the background (no window). Log: state\guard.log
