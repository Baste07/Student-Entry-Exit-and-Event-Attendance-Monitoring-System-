@echo off
title Stop SAMS Engine
echo ===================================================
echo Shutting down the Facial Recognition Service...
echo ===================================================

taskkill /F /IM pythonw.exe /T

echo.
echo SUCCESS: The Lab System has been stopped.
echo ===================================================
pause