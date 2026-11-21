@echo off
title VocabMaster - Refresh Windows Icon & Taskbar Cache
color 0b
echo ===================================================================
echo     VocabMaster - Rebuild Windows Icon Cache & Taskbar Icons
echo ===================================================================
echo.
echo [1/4] Closing running VocabMaster processes...
taskkill /f /im VocabMaster.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Terminating Windows Explorer to release icon cache handles...
taskkill /f /im explorer.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [3/4] Purging Windows icon and thumbnail caches...
cd /d "%userprofile%\AppData\Local"
if exist IconCache.db (
    del /a /f /q IconCache.db >nul 2>&1
    echo       - Deleted: %userprofile%\AppData\Local\IconCache.db
)

cd /d "%userprofile%\AppData\Local\Microsoft\Windows\Explorer"
attrib -h -r -s iconcache_*.db >nul 2>&1
del /f /q iconcache_*.db >nul 2>&1
attrib -h -r -s thumbcache_*.db >nul 2>&1
del /f /q thumbcache_*.db >nul 2>&1
echo       - Cleared Explorer iconcache_*.db and thumbcache_*.db

echo [4/4] Restarting Windows Explorer...
start explorer.exe

echo.
echo ===================================================================
echo   SUCCESS! Windows Icon Cache has been rebuilt cleanly.
echo   VocabMaster Taskbar icon is now razor-sharp and punchy!
echo ===================================================================
echo.
pause
