@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
rem Hidden launches (restart.bat -> run-hidden.vbs) have no window at all, so a
rem missing node on PATH would just scroll into state\guard.log and never surface:
rem fall back to the DSH runtime node when "node" is not resolvable.
where node >nul 2>nul || set "PATH=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;%PATH%"
rem Bootstrap may be a node.cmd shim; the selector probes Node 24 and sqlite.backup.
rem Never use an inherited SnowLuma Node 22 for the bridge itself.
set "QQBRIDGE_NODE="
for /f "delims=" %%N in ('call node scripts\bridge-node.mjs') do set "QQBRIDGE_NODE=%%N"
if not defined QQBRIDGE_NODE (
    echo [bridge] No compatible Node 24 runtime found. Set QQBRIDGE_NODE_EXE.
    exit /b 1
)
echo [bridge] Runtime: "%QQBRIDGE_NODE%"
call "%QQBRIDGE_NODE%" scripts\harden-state-acl.mjs --quiet
:loop
call "%QQBRIDGE_NODE%" src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    rem exit code 2 = another bridge already holds state\bridge.lock. Common source:
    rem the bridge spawned by the DSH app itself (a second supervisor). This used to
    rem exit here at once; then when that instance died nobody restarted anything.
    rem Now we wait and look again: if that instance is still alive the next attempt
    rem still returns code 2, cost is just one node start; if it is gone we take over.
    echo [%date% %time%] bridge already running elsewhere; will re-check in 120 seconds.
    ping -n 121 127.0.0.1 >nul
    goto loop
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto loop
