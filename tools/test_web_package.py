"""Offline smoke test of the PHP-hosted WEB package, with no local engines."""
from __future__ import annotations

from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
from urllib.request import urlopen
from urllib.request import Request
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "web"


def main() -> None:
    subprocess.run(["python", str(ROOT / "tools" / "build_web.py"), "--test-config"], check=True)
    required = [
        "index.html", "auth/login.html", "auth/mfa.html", "auth/reset-password.html",
        "portal/portal.html", "admin/usermanagement.html", "admin/student-import.html",
        "admin/teachermanagement.html", "admin/system-settings.html",
        "TimeInAndTimeOutMonitoring/admin/events.html",
        "TimeInAndTimeOutMonitoring/admin/eventAttendance.html",
        "TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html",
        "TimeInAndTimeOutMonitoring/admin/eventSettings.html",
        "EntryExitMonitoring/admin/entry-exitLogs.html",
        "EntryExitMonitoring/admin/reports.html", "EntryExitMonitoring/admin/settings.html",
        "admin/send-student-qr-email.php", "admin/create-admin.php",
    ]
    excluded = [
        "auth/register.html", "TimeInAndTimeOutMonitoring/students/takeAttendance.html",
        "TimeInAndTimeOutMonitoring/students/accountRegistration.html",
        "TimeInAndTimeOutMonitoring/students/flask_attendance.py",
        "TimeInAndTimeOutMonitoring/students/trigger_attendance.php",
        "TimeInAndTimeOutMonitoring/students/send_event_attendance_email.php",
        "EntryExitMonitoring/gate/entryExitScanner.html",
        "EntryExitMonitoring/gate/qrAttendance.html",
        "TimeInAndTimeOutMonitoring/admin/engine_log.html", "Gemma/main.py",
    ]
    assert all((OUT / name).is_file() for name in required)
    assert all(not (OUT / name).exists() for name in excluded)
    for local in ("TimeInAndTimeOutMonitoring/students/takeAttendance.html",
                  "TimeInAndTimeOutMonitoring/students/accountRegistration.html",
                  "TimeInAndTimeOutMonitoring/students/face_capture.py",
                  "TimeInAndTimeOutMonitoring/students/flask_attendance.py",
                  "EntryExitMonitoring/gate/entryExitScanner.html"):
        assert (ROOT / "EVENTMONITORING" / local).is_file(), local
    assert "DEPLOYMENT_MODE: 'WEB'" in (OUT / "config" / ".env.js").read_text()
    assert not any(p.name == ".env" for p in OUT.rglob("*"))
    for file in OUT.rglob("*"):
        if file.is_file() and file.suffix in {".html", ".js"}:
            content = file.read_text(encoding="utf-8", errors="replace")
            assert not re.search(r"https?://127\.0\.0\.1:500[01]", content), file

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    php = shutil.which("php")
    assert php, "PHP CLI is required for the web smoke test"
    proc = subprocess.Popen([php, "-S", f"127.0.0.1:{port}", "-t", str(OUT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(30):
            try:
                with urlopen(f"http://127.0.0.1:{port}/auth/login.html", timeout=2) as response:
                    assert response.status == 200
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise AssertionError("PHP test server did not start")
        for page in required:
            if page.endswith(".php"):
                continue  # Protected endpoints need a real AAL2 test identity.
            with urlopen(f"http://127.0.0.1:{port}/{page}", timeout=3) as response:
                assert response.status == 200, page
        for endpoint in ("admin/create-admin.php", "admin/delete-admin.php",
                         "admin/admin-mfa-factors.php", "admin/send-student-qr-email.php"):
            body = (b'{"action":"status","adminId":"00000000-0000-0000-0000-000000000001"}'
                    if endpoint.endswith("admin-mfa-factors.php") else b"{}")
            request = Request(f"http://127.0.0.1:{port}/{endpoint}", data=body,
                              headers={"Content-Type": "application/json"}, method="POST")
            try:
                urlopen(request, timeout=3)
                raise AssertionError(f"Unauthenticated request accepted: {endpoint}")
            except HTTPError as error:
                assert error.code == 401, (endpoint, error.code)
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    print("WEB package smoke passed: management pages served by PHP; unauthenticated PHP actions rejected; no local engines")


if __name__ == "__main__":
    main()
