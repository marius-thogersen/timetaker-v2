@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:4577
node server\server.js
pause
