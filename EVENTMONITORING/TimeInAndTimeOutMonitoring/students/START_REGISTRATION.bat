@echo off
title SAMS Registration Engine
echo ===================================================
echo Starting Face Registration Engine (Port 5001)
echo ===================================================

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":5001 .*LISTENING"') do (
	echo Registration engine already running on port 5001 ^(PID %%p^)
	exit /b 0
)

start "" "C:\Users\PLPASIG\pythonnn\pythonw.exe" "%~dp0face_capture.py"
exit