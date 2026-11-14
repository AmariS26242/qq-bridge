' Open the qq-bridge local console with NO console window.
'
' Why this exists: the console (127.0.0.1:3100) requires a token, and the token may
' be regenerated whenever the bridge restarts. A browser bookmark with a hard-coded
' token breaks silently (401). This wrapper re-reads state\console-token on every
' launch, so the entry keeps working forever.
'
' The shortcut target is:
'   wscript.exe //B //Nologo "<this file>"
'
' ASCII only on purpose (VBS files are read as ANSI; Chinese text would be mojibake).
' All user-facing text is produced by the Node helper in UTF-8.

Option Explicit

Dim sh, fso, env, base, nodeExe, candidates, i, scriptPath, cmd, ok, extra, a, j

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set env = sh.Environment("PROCESS")

base = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = base & "\scripts\open-console.mjs"

If Not fso.FileExists(scriptPath) Then
  MsgBox "open-console.mjs not found:" & vbCrLf & scriptPath, 16, "QQ Console"
  WScript.Quit 2
End If

nodeExe = ""
candidates = Array( _
  env("USERPROFILE") & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe", _
  base & "\..\SnowLuma\node.exe")
For i = 0 To UBound(candidates)
  If nodeExe = "" Then
    If fso.FileExists(candidates(i)) Then nodeExe = candidates(i)
  End If
Next
If nodeExe = "" Then nodeExe = "node"

' Forward arguments (used by diagnostics, e.g. open-console.vbs --print).
extra = ""
For j = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(j)
  If InStr(a, " ") > 0 Then a = """" & a & """"
  extra = extra & " " & a
Next
' Window style 0 = hidden, wait = True so a failure is visible instead of silent.
' (Node opens the default browser itself; blocking here is only a second or two.)
cmd = """" & nodeExe & """ """ & scriptPath & """" & extra
ok = sh.Run(cmd, 0, True)
If ok <> 0 Then
  MsgBox "Console did not open (exit code " & ok & ")." & vbCrLf & vbCrLf & _
         "Run this in a terminal to see why:" & vbCrLf & _
         "  node scripts\open-console.mjs", 48, "QQ Console"
End If
