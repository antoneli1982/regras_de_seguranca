@echo off
chcp 65001 >nul
rem ============================================================
rem  SESE Studio - Modo TV (tela cheia, troca automatica, em ciclo)
rem  Para sair na TV: Alt+F4
rem ============================================================

rem Tempo de cada pagina, em segundos (5 a 600):
set "TEMPO=10"

set "PASTA=%~dp0"
set "PASTA=%PASTA:\=/%"
set "URL=file:///%PASTA%index.html#tv&tempo=%TEMPO%"
set "PERFIL=%LOCALAPPDATA%\SESE-TV"

set "NAV=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%NAV%" goto abrir
set "NAV=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%NAV%" goto abrir
set "NAV=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "%NAV%" goto abrir
set "NAV=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%NAV%" goto abrir
set "NAV=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%NAV%" goto abrir
echo Nao encontrei o Google Chrome nem o Microsoft Edge neste computador.
pause
exit /b 1

:abrir
start "" "%NAV%" --kiosk --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --user-data-dir="%PERFIL%" --no-first-run --no-default-browser-check --disable-session-crashed-bubble --disable-features=Translate --overscroll-history-navigation=0 --disable-pinch "%URL%"
exit /b 0
