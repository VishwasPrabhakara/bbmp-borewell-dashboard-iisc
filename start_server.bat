@echo off
REM Start a local HTTP server for the dashboard and open it in the default browser.
cd /d "%~dp0"
start "" http://localhost:8000/
python -m http.server 8000
pause
