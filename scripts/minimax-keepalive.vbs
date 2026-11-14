' Run the daily MiniMax voice keepalive without flashing a console window.
Option Explicit
Dim sh, fso, base, bridge, nodeExe, script, outLog, errLog, q, cmd, rc, i, cand
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
bridge = fso.GetParentFolderName(base)
If Not fso.FolderExists(bridge & "\state") Then fso.CreateFolder(bridge & "\state")
script = base & "\minimax-keepalive.mjs"
outLog = bridge & "\state\minimax-keepalive.out.log"
errLog = bridge & "\state\minimax-keepalive.err.log"
nodeExe = ""
cand = Array( _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe", _
  sh.ExpandEnvironmentStrings("%PROGRAMFILES%") & "\nodejs\node.exe", _
  "C:\Program Files\nodejs\node.exe", _
  sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" _
)
For i = 0 To UBound(cand)
  If nodeExe = "" And fso.FileExists(cand(i)) Then nodeExe = cand(i)
Next
If nodeExe = "" Then nodeExe = "node"
q = Chr(34)
cmd = "cmd.exe /d /s /c " & q & q & nodeExe & q & " " & q & script & q & " >> " & q & outLog & q & " 2>> " & q & errLog & q & q
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
