' this is to launch node without a terminal window 
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node server.js C:\path\to\index.htm", 0