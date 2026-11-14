' Launch scripts\daily-brief.mjs with NO console window, as the Task Scheduler entry point.
'
' Usage (registered task action):
'   wscript.exe //B //Nologo "C:\...\qq-bridge\scripts\daily-brief.vbs"
'
' Why a VBS instead of letting schtasks call node.exe directly:
'   * node.exe is a console app; launched from a console-less context Windows would
'     still flash a window for one frame. SW_HIDE (window style 0) means no window
'     ever exists.
'   * it keeps the redirect in one place: the script's own records go to
'     state\daily-brief.log, while raw stdout/stderr (which is where the harmless
'     schtasks S-1-16-4096 noise lands) go to state\daily-brief.out.log.
'
' Run(..., 0, True) waits: the task's "last run result" then reflects the real
' outcome instead of "still starting". Exit code is forwarded, so 0 = sent or
' intentionally skipped, 2 = send failed (see state\daily-brief.log).
'
' ASCII only. No reliance on the caller's working directory.
Option Explicit
Dim sh, fso, base, bridge, nodeExe, script, outLog, errLog, q, cmd, rc, i, cand

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)          ' ...\qq-bridge\scripts
bridge = fso.GetParentFolderName(base)                          ' ...\qq-bridge

If Not fso.FolderExists(bridge & "\state") Then fso.CreateFolder(bridge & "\state")
script = base & "\daily-brief.mjs"
outLog = bridge & "\state\daily-brief.out.log"
errLog = bridge & "\state\daily-brief.err.log"

If Not fso.FileExists(script) Then
  WScript.Echo "missing script: " & script
  WScript.Quit 3
End If

' Keep the raw output logs from growing forever (they are only ever appended to).
On Error Resume Next
If fso.FileExists(outLog) Then
  If fso.GetFile(outLog).Size > 1048576 Then fso.DeleteFile outLog, True
End If
If fso.FileExists(errLog) Then
  If fso.GetFile(errLog).Size > 1048576 Then fso.DeleteFile errLog, True
End If
On Error GoTo 0

' Node: prefer the node bundled INSIDE the installed DSH app (AppData\Local\Programs).
' IMPORTANT: the copy under %USERPROFILE%\.dsh\dsh-runtimes is write-restricted on this
' machine (workspace-only writes, EPERM elsewhere) although it is the same binary, so it
' stays last resort. See scripts\backup.vbs for the probe that proved this.
nodeExe = ""
cand = Array( _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe", _
  sh.ExpandEnvironmentStrings("%PROGRAMFILES%") & "\nodejs\node.exe", _
  "C:\Program Files\nodejs\node.exe", _
  "C:\Program Files (x86)\nodejs\node.exe", _
  sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" _
)
For i = 0 To UBound(cand)
  If nodeExe = "" Then
    If fso.FileExists(cand(i)) Then nodeExe = cand(i)
  End If
Next
If nodeExe = "" Then nodeExe = "node"

q = Chr(34)
' Outer quotes around the whole /c payload plus /s: the form cmd.exe undoes safely,
' so a node path containing spaces still works.
' stderr goes to its own file: the campus-net probe calls schtasks, which on a
' Low-integrity caller writes a GBK "path not found" line to stderr. Redirecting
' that to out.log would splatter mojibake lines into the readable log.
cmd = "cmd.exe /d /s /c " & q & q & nodeExe & q & " " & q & script & q & " >> " & q & outLog & q & " 2>> " & q & errLog & q & q
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
