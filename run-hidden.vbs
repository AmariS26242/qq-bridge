' Launch the qq-bridge restart guard (start.bat) with NO console window at all.
'
' Why this exists: restart.bat used to end with
'     start "" cmd /c start.bat
' which opens a NEW, VISIBLE cmd window on the desktop every time the bridge is
' restarted. Here wscript creates the process itself with SW_HIDE (window style 0),
' so the console never exists as a visible window - not even for one frame.
'
' Usage (from restart.bat):
'   wscript.exe //B //Nologo "%~dp0run-hidden.vbs" start.bat
'
' Two details that matter:
'   * the child gets HIDDEN_LAUNCH=1 in its environment, so a script can skip an
'     interactive prompt it can no longer be answered (start.bat checks it before
'     its "bridge already running" pause);
'   * its output is appended to state\guard.log, because the hidden console is the
'     only place those lines used to go.
'
' A bare script name is resolved against this file's own folder. ASCII only.
Dim sh, fso, env, base, target, extra, cmd, i, a, q
If WScript.Arguments.Count = 0 Then WScript.Quit 2
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName) & "\"
target = WScript.Arguments(0)
If InStr(target, "\") = 0 Then target = base & target
extra = ""
For i = 1 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = """" & a & """"
  extra = extra & " " & a
Next
If Not fso.FolderExists(base & "state") Then fso.CreateFolder(base & "state")
Set env = sh.Environment("PROCESS")
env("HIDDEN_LAUNCH") = "1"
' Outer quotes around the whole /c payload plus /s: that is the form cmd.exe undoes
' safely, so a target path containing spaces still works. Without the outer pair cmd
' strips the wrong quote and the redirect is never applied (silent no-op).
q = Chr(34)
cmd = "cmd.exe /d /s /c " & q & q & target & q & extra & " >> " & q & base & "state\guard.log" & q & " 2>&1" & q
sh.Run cmd, 0, False
