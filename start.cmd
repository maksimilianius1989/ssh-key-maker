@echo off
rem Windows: installs (after asking) Node.js and Electron, then starts SSH Key Maker.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
rem Keep the window open on failure so the message can be read (double-click start)
if errorlevel 1 pause
