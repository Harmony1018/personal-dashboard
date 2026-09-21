@echo off
rem ---------------------------------------------------------------
rem  Import the exported xlsx into the dashboard.
rem
rem  Keep this file ASCII-only. cmd.exe parses .bat files byte by byte
rem  using the system ANSI codepage; Chinese text here gets split
rem  mid-character and breaks the commands, and "chcp 65001" does not
rem  fix parsing of the file itself. All Chinese output comes from the
rem  Node script instead, which handles UTF-8 correctly.
rem
rem  Usage:
rem    1) drag an .xlsx onto this file, or
rem    2) just double-click it -- the script looks for the newest
rem       exported file on the desktop and in Downloads.
rem
rem  Either way it asks which date the data belongs to, because an
rem  export made today can carry any day's figures. Press Enter to use
rem  today. The prompt text is English on purpose -- see the note above.
rem ---------------------------------------------------------------
cd /d "%~dp0"

rem Switch the console to UTF-8 so the Node script's Chinese output renders
rem correctly. This line itself is plain ASCII, so it parses fine -- it is
rem the Chinese *text* in a .bat that breaks cmd, not this.
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js not found. Install Node.js first, then try again.
  echo.
  pause
  exit /b 1
)

set "D="
set /p "D=Which date is this data for? YYYY-MM-DD, Enter = today: "

if "%D%"=="" (
  node "scripts\import-pdd-export.mjs" %*
) else (
  node "scripts\import-pdd-export.mjs" %* --date %D%
)

echo.
pause
