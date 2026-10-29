' Windows: starts SSH Key Maker without a console window (used by the "SSH Key Maker" shortcut).
' Electron not installed yet -> opens start.cmd, which installs it (after asking) and starts the app.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\electron\node_modules\electron\dist\electron.exe"
If fso.FileExists(exe) Then
    shell.Run """" & exe & """ """ & root & "\electron""", 1, False
Else
    shell.Run """" & root & "\start.cmd""", 1, False
End If
