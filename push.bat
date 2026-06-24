@echo off
echo.
echo ============================================
echo   PiSecureCloud - GitHub Auto-Upload
echo ============================================
echo.

rem Check if git is installed
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo Fehler: Git ist auf diesem PC nicht installiert!
    echo Bitte installiere Git fuer Windows: https://git-scm.com/
    pause
    exit /b
)

rem Check if git repository
git status >nul 2>&1
if %errorlevel% neq 0 (
    echo Fehler: Kein Git-Repository in diesem Ordner gefunden.
    pause
    exit /b
)

echo [1/3] Fuege Aenderungen hinzu...
git add -A

echo [2/3] Erstelle Commit...
git commit -m "Auto-Update"

echo [3/3] Lade auf GitHub hoch...
git push origin main

if %errorlevel% equ 0 (
    echo.
    echo ============================================
    echo   UPLOAD ERFOLGREICH!
    echo   Fuehre jetzt auf deinem Pi aus:
    echo   sudo pisecurecloud-update
    echo ============================================
) else (
    echo.
    echo [!] FEHLER: Hochladen fehlgeschlagen.
    echo Hast du die GitHub-Verbindung eingerichtet?
)
echo.
pause
