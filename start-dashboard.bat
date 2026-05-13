@echo off
cd /d "C:\Users\anupa\Downloads\cl\dashboard"
start "Dashboard Server" cmd /k "npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173"
