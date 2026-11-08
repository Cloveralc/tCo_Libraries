@echo off
cd /d "%~dp0"
chcp 65001 >nul
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0local-server.ps1"
if errorlevel 1 pause
