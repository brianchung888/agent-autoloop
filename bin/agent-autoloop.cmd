@echo off
rem Windows reads no shebang, so this is what bin/agent-autoloop.ts is started by here. %* is the command line as it was
rem typed, quotes and all: nothing is taken apart and put back together, which is what would lose a quoted argument.
setlocal
node --disable-warning=ExperimentalWarning "%~dp0agent-autoloop.ts" %*
exit /b %ERRORLEVEL%
