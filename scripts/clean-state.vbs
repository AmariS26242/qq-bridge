' Launch scripts\clean-state.mjs --apply with NO console window (weekly disk hygiene).
'
' Usage (registered task action):
'   wscript.exe //B //Nologo "C:\...\qq-bridge\scripts\clean-state.vbs"
'
' Same shape as backup.vbs / doctor.vbs: SW_HIDE so no window ever exists, Run(..., 0, True)
' so the task's "last run result" is the real exit code (0 = ok, 2 = nothing removed but
' something failed).
'
' Runs `--apply` deliberately: the dry run is for humans, this is the weekly job the plan
' asked for. Triggers stay conservative (junk 3 days / cache 7 days in config.cleanState),
' so even a buggy rule needs three days of files to do damage.
'
' ASCII only. No reliance on the caller's working directory.
Option Explicit
Dim sh, fso, base, bridge, nodeExe, script, outLog, errLog, q, cmd, rc, i, cand

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)          ' ...\qq-bridge\scripts
bridge = fso.GetParentFolderName(base)                          ' ...\qq-bridge

If Not fso.FolderExists(bridge & "\state") Then fso.CreateFolder(bridge & "\state")
script = base & "\clean-state.mjs"
outLog = bridge & "\state\clean-state.out.log"
errLog = bridge & "\state\clean-state.err.log"

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

' Node: prefer the copy bundled inside the installed DSH app. The %USERPROFILE%\.dsh copy is
' write-restricted on this machine (workspace-only, EPERM elsewhere) though it is the same
' binary -- see scripts\backup.vbs for the probe that proved it.
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
cmd = "cmd.exe /d /s /c " & q & q & nodeExe & q & " " & q & script & q & " --apply >> " & q & outLog & q & " 2>> " & q & errLog & q & q
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
