@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ===================================================
echo  SAMS - TimeInAndTimeOutMonitoring
echo  Dependency Installer v1.0
echo ===================================================
echo.

REM ── Step 1: Locate Python ────────────────────────────
set "PYTHON_EXE="

if exist ".venv\Scripts\python.exe" (
    set "PYTHON_EXE=.venv\Scripts\python.exe"
    echo [OK] Found existing virtual environment: .venv
    goto :install_deps
)

echo [INFO] No virtual environment found. Creating one...
echo.

where py >nul 2>&1
if %errorlevel%==0 (
    echo [INFO] Using py launcher to create virtual environment...
    py -3 -m venv .venv
    goto :check_venv
)

where python >nul 2>&1
if %errorlevel%==0 (
    echo [INFO] Using python to create virtual environment...
    python -m venv .venv
    goto :check_venv
)

echo.
echo [ERROR] Python was not found on this machine.
echo         Please install Python 3.10 or 3.11 (64-bit) from https://www.python.org
echo         Make sure to check "Add Python to PATH" during installation.
echo.
pause
exit /b 1

:check_venv
if not exist ".venv\Scripts\python.exe" (
    echo.
    echo [ERROR] Failed to create virtual environment.
    echo         Make sure Python 3.10 or 3.11 (64-bit) is installed correctly.
    echo.
    pause
    exit /b 1
)
set "PYTHON_EXE=.venv\Scripts\python.exe"
echo [OK] Virtual environment created successfully.

:install_deps
echo.
echo ───────────────────────────────────────────────────
echo  Step 1 of 3: Upgrading pip...
echo ───────────────────────────────────────────────────
"%PYTHON_EXE%" -m pip install --upgrade pip --quiet
if %errorlevel% neq 0 (
    echo [WARNING] pip upgrade failed. Continuing with existing version...
)
echo [OK] pip is up to date.

echo.
echo ───────────────────────────────────────────────────
echo  Step 2 of 3: Installing core dependencies...
echo ───────────────────────────────────────────────────
echo  (This may take several minutes on first install)
echo.

"%PYTHON_EXE%" -m pip install ^
    flask==3.1.0 ^
    flask-cors==5.0.1 ^
    python-dotenv==1.1.0 ^
    supabase==2.15.1 ^
    requests==2.32.3 ^
    numpy==2.2.6 ^
    opencv-python==4.11.0.86 ^
    mediapipe==0.10.21

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Core dependency installation failed.
    echo         Check your internet connection and try again.
    echo.
    pause
    exit /b 1
)
echo.
echo [OK] Core dependencies installed.

echo.
echo ───────────────────────────────────────────────────
echo  Step 3 of 3: Installing face_recognition (dlib)...
echo ───────────────────────────────────────────────────
echo  (This step may take 5-15 minutes to compile dlib)
echo.

"%PYTHON_EXE%" -m pip install face_recognition==1.3.0

if %errorlevel% neq 0 (
    echo.
    echo [WARNING] face_recognition installation failed.
    echo.
    echo  This usually means dlib could not be compiled.
    echo  To fix this, install the following tools FIRST then re-run this installer:
    echo.
    echo    1. Microsoft C++ Build Tools:
    echo       https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo       (Select "Desktop development with C++" workload)
    echo.
    echo    2. CMake:
    echo       https://cmake.org/download/
    echo       (Check "Add CMake to system PATH" during install)
    echo.
    echo  Alternatively, install a pre-built dlib wheel:
    echo    https://github.com/z-mahmud22/Dlib_Windows_Python3.x
    echo.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo  SUCCESS: All dependencies installed!
echo ===================================================
echo.
echo  Virtual environment : %cd%\.venv
echo  Python executable   : %cd%\.venv\Scripts\python.exe
echo.
echo  NEXT STEPS:
echo  1. Configure your .env file in the students\ folder:
echo.
echo     SUPABASE_URL=https://wjyoruvcyjnwsimeqrgl.supabase.co
echo     SUPABASE_KEY=^<your-service-role-key^>   ^<^<^< REQUIRED: get from Supabase
echo     REBUILD_SECRET=r3bU1d_Xv9Qe7s2KzF4gH6pT0aW8yN3b
echo     ATTENDANCE_TRIGGER=http://127.0.0.1:5000/trigger_rebuild
echo.
echo     Find your Service Role key at:
echo     https://supabase.com/dashboard/project/wjyoruvcyjnwsimeqrgl
echo     Go to: Settings ^> API ^> Project API Keys ^> service_role (secret)
echo.
echo  2. Run START_ATTENDANCE.bat to launch the attendance engine (port 5000).
echo  3. Run START_REGISTRATION.bat to launch the registration engine (port 5001).
echo.
echo  For help, check engine_log.txt and registration_log.txt
echo  after the services start.
echo.
pause
exit /b 0