@echo off
title SAMS Attendance Engine
echo ===================================================
echo Starting Lab Attendance Engine (Port 5000)
echo ===================================================

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":5000 .*LISTENING"') do (
	echo Engine already running on port 5000 ^(PID %%p^)
	exit /b 0
)

start "" "C:\Users\PLPASIG\pythonnn\pythonw.exe" "%~dp0flask_attendance.py"
exit