' Launch scripts\weekly-report.mjs with NO console window, as the Task Scheduler entry point.
'
' Usage (registered task action):
'   wscript.exe //B //Nologo "C:\...\qq-bridge\scripts\weekly-report.vbs"
' Same shape as backup.vbs / doctor.vbs / clean-state.vbs on purpose: node.exe is a console
' app, so SW_HIDE (window style 0) keeps the one-frame flash from ever appearing. Run(...,
' 0, True) waits, so the task's "last run result" is the real exit code (0 = ok / skipped,
' 2 = send failed) instead of "still starting".
'
' Optional args are passed through to the .mjs, so the same file can be probed by hand:
'   wscript //B //Nologo scripts\weekly-report.vbs --dry
'
' ASCII only. No reliance on the caller's working directory.
Option Explicit
Dim sh, fso, base, bridge, nodeExe, script, outLog, errLog, q, cmd, rc, i, cand, extra, j

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)          ' ...\qq-bridge\scripts
bridge = fso.GetParentFolderName(base)                          ' ...\qq-bridge

If Not fso.FolderExists(bridge & "\state") Then fso.CreateFolder(bridge & "\state")
script = base & "\weekly-report.mjs"
outLog = bridge & "\state\weekly-report.out.log"
errLog = bridge & "\state\weekly-report.err.log"

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
' machine -- it can only write inside the workspace and returns EPERM elsewhere (same
' node.exe SHA256, so the restriction is path-based, not binary-based). The weekly report
' reads state/ and talks to OneBot over HTTP, so the restricted copy would still work, but
' the order stays identical to the other launchers to keep one story.
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

' Pass through any extra switches (--dry / --send-test / --force); flags only, no spaces.
extra = ""
For j = 0 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(j)
Next

q = Chr(34)
' Outer quotes around the whole /c payload plus /s: the form cmd.exe undoes safely,
' so a node path containing spaces still works.
cmd = "cmd.exe /d /s /c " & q & q & nodeExe & q & " " & q & script & q & extra & " >> " & q & outLog & q & " 2>> " & q & errLog & q & q
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
