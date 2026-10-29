@echo off
rem Windows: installs (after asking) Node.js and Electron, then starts SSH Key Maker.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
