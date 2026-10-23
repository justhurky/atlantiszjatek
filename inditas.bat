@echo off
chcp 65001 >nul
title Atlantisz jatek
cd /d "%~dp0"
where node >nul 2>nul || (echo A Node.js nincs telepitve: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Elso inditas: a szukseges csomagok telepitese...
  call npm install --omit=dev || (pause & exit /b 1)
)
echo.
echo A jatek indul. Leallitas: Ctrl+C, vagy zard be ezt az ablakot.
echo Ha a Windows tuzfal rakerdez, engedelyezd a "Magan halozatok" eseteben.
echo.
node src\server.js
pause
