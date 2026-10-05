@echo off
setlocal

rem Copy this template to START_ATTENDANCE.bat in the same directory.
rem The real launcher and the logs below are machine-local and Git-ignored.
rem Do not put Supabase keys or other credentials in this batch file.
rem Set PYTHONW to this machine's full pythonw.exe path if it is not on PATH.
set "ENGINE_DIR=%~dp0"
set "LAUNCHER_LOG=%ENGINE_DIR%attendance_launcher_error.log"
if not defined PYTHONW for %%I in (pythonw.exe) do set "PYTHONW=%%~$PATH:I"
if not defined PYTHONW (
    >>"%LAUNCHER_LOG%" echo pythonw.exe was not found. Set PYTHONW to its full local path.
    exit /b 1
)
if not exist "%PYTHONW%" (
    >>"%LAUNCHER_LOG%" echo The configured pythonw.exe was not found.
    exit /b 1
)

rem The shared attendance engine serves Entry/Exit and Event Attendance on port 5000.
rem trigger_attendance.php requires an active AAL2 Admin session before invoking
rem START_ATTENDANCE.bat. Verify http://127.0.0.1:5000/engine_status after start.
rem The existing STOP_ENGINE.bat and authenticated /shutdown endpoint stop pythonw.exe.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":5000 .*LISTENING"') do exit /b 0

rem flask_attendance.py writes its runtime diagnostics to ignored engine_log.txt.
rem These additional ignored logs retain errors before Python initializes that file.
powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Process -FilePath $env:PYTHONW -ArgumentList (Join-Path $env:ENGINE_DIR 'flask_attendance.py') -WorkingDirectory $env:ENGINE_DIR -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:ENGINE_DIR 'attendance_process_stdout.log') -RedirectStandardError (Join-Path $env:ENGINE_DIR 'attendance_process_stderr.log')" 2>>"%LAUNCHER_LOG%"
exit /b %ERRORLEVEL%
