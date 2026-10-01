"""Build an allowlisted online-management package; never copies local engines.

Production build: set WEB_SUPABASE_URL and WEB_SUPABASE_ANON_KEY in the shell.
Dry-run build: --test-config writes an unusable public placeholder configuration.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "EVENTMONITORING"
OUT = ROOT / "dist" / "web"
ALLOWLIST = ROOT / "tools" / "web_allowlist.txt"

TOP = ["index.html"]
DIRS = ["auth", "portal", "admin", "shared", "config"]
MODULES = ["TimeInAndTimeOutMonitoring", "EntryExitMonitoring"]
WEB_PHP = {
    "admin/create-admin.php", "admin/delete-admin.php",
    "admin/admin-mfa-factors.php", "admin/update-admin-email.php",
    "admin/send-student-qr-email.php", "admin/admin-mfa-auth.php",
    "config/supabase-server.php",
    "TimeInAndTimeOutMonitoring/students/mail_config.php",
    "TimeInAndTimeOutMonitoring/students/PHPMailer/Exception.php",
    "TimeInAndTimeOutMonitoring/students/PHPMailer/PHPMailer.php",
    "TimeInAndTimeOutMonitoring/students/PHPMailer/SMTP.php",
}
LOCAL_HTML = {"TimeInAndTimeOutMonitoring/admin/engine_log.html", "TimeInAndTimeOutMonitoring/admin/home.html"}
LOCAL_JS = {
    "TimeInAndTimeOutMonitoring/resc/js/accountRegistration.js",
    "TimeInAndTimeOutMonitoring/resc/js/takeAttendance.js",
    "TimeInAndTimeOutMonitoring/resc/js/manualAttendance.js",
    "TimeInAndTimeOutMonitoring/resc/js/homepage.js",
    "EntryExitMonitoring/resc/js/entryExitScanner.js",
    "EntryExitMonitoring/resc/js/qrAttendance.js",
}
LOCAL_CSS = {
    "TimeInAndTimeOutMonitoring/resc/css/accountRegistration.css",
    "TimeInAndTimeOutMonitoring/resc/css/takeAttendance.css",
    "TimeInAndTimeOutMonitoring/resc/css/manualAttendance.css",
    "TimeInAndTimeOutMonitoring/resc/css/homepage.css",
    "EntryExitMonitoring/resc/css/entryExitScanner.css",
    "EntryExitMonitoring/resc/css/qrAttendance.css",
}
SAFE_ASSET_EXT = {".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".gif", ".webp", ".woff", ".woff2", ".ttf"}
STATIC_REF = re.compile(r'''(?:src|href)=["']([^"']+)["']''', re.I)


def include(rel: Path) -> bool:
    path = rel.as_posix()
    parts = rel.parts
    if path in TOP or path in WEB_PHP:
        return True
    if path == "Gemma/gemma.css":
        return True
    if parts[0] in DIRS:
        if parts[0] == "config":
            return path == "config/config.js"
        if path in {"auth/register.html", "auth/register.js", "auth/register.css"}:
            return False  # Legacy professor signup writes a plaintext password into a profile.
        if path == "admin/sample.php":
            return False
        if rel.suffix == ".php":
            return False
        return rel.suffix.lower() in SAFE_ASSET_EXT or rel.suffix == ".html"
    if parts[0] in MODULES:
        if path in LOCAL_HTML | LOCAL_JS | LOCAL_CSS:
            return False
        if len(parts) > 1 and parts[1] == "admin":
            return rel.suffix == ".html" or path == "EntryExitMonitoring/admin/.htaccess"
        if len(parts) > 1 and parts[1] == "includes":
            return rel.suffix in {".html", ".js"}
        if len(parts) > 1 and parts[1] == "resc":
            return rel.suffix.lower() in SAFE_ASSET_EXT
    return False


def validate_assets() -> None:
    missing = []
    for page in OUT.rglob("*.html"):
        if "includes" in page.parts:
            continue  # Fragments are resolved relative to their containing admin page.
        html = re.sub(r"<!--.*?-->", "", page.read_text(encoding="utf-8", errors="replace"), flags=re.S)
        for ref in STATIC_REF.findall(html):
            if ref.startswith(("http:", "https:", "data:", "#", "mailto:", "javascript:")):
                continue
            ref = ref.split("?", 1)[0].split("#", 1)[0]
            if not ref or ref.startswith("/"):
                continue
            if ref.endswith("students/homepage.html"):
                continue  # LOCAL_GATE card is hidden in WEB mode.
            target = (page.parent / ref).resolve()
            if not target.is_relative_to(OUT.resolve()) or not target.exists():
                missing.append(f"{page.relative_to(OUT)} -> {ref}")
    if missing:
        raise RuntimeError("Missing web assets/pages:\n" + "\n".join(missing))


def validate_no_server_secrets() -> None:
    jwt_pattern = re.compile(r"eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+")
    for file in OUT.rglob("*"):
        if not file.is_file() or file.suffix not in {".js", ".php", ".html", ".css"}:
            continue
        source = file.read_text(encoding="utf-8", errors="replace")
        if re.search(r"sb_secret_[A-Za-z0-9_-]{8,}", source):
            raise RuntimeError(f"Server secret detected in {file.relative_to(OUT)}")
        for match in jwt_pattern.finditer(source):
            try:
                payload = match.group(1)
                claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            except (ValueError, UnicodeDecodeError):
                continue
            if claims.get("role") == "service_role":
                raise RuntimeError(f"Service-role token detected in {file.relative_to(OUT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-config", action="store_true", help="Use nonfunctional placeholder browser config")
    args = parser.parse_args()
    url = "https://example.invalid" if args.test_config else os.getenv("WEB_SUPABASE_URL", "")
    anon = "TEST_PUBLIC_ANON_KEY" if args.test_config else os.getenv("WEB_SUPABASE_ANON_KEY", "")
    if not url.startswith("https://") or not anon:
        parser.error("Set WEB_SUPABASE_URL (HTTPS) and WEB_SUPABASE_ANON_KEY, or use --test-config")
    if not args.test_config:
        public_key = anon.startswith("sb_publishable_")
        if anon.count(".") == 2:
            try:
                payload = anon.split(".")[1]
                claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
                public_key = claims.get("role") == "anon"
            except (ValueError, UnicodeDecodeError):
                public_key = False
        if not public_key:
            parser.error("WEB_SUPABASE_ANON_KEY must be an anon or publishable key, never a service-role/secret key")

    files = []
    for line in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        name = line.strip()
        if not name or name.startswith("#"):
            continue
        rel = Path(name)
        if rel.is_absolute() or ".." in rel.parts or not include(rel):
            raise RuntimeError(f"Unsafe or unreviewed manifest entry: {name}")
        src = APP / rel
        if not src.is_file():
            raise RuntimeError(f"Missing manifest source file: {name}")
        files.append(src)
    if len(files) != len(set(files)):
        raise RuntimeError("Duplicate manifest path")
    if OUT.exists():
        shutil.rmtree(OUT)
    for src in files:
        dest = OUT / src.relative_to(APP)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    public_config = f"const ENV = {{ SUPABASE_PROJECT_URL: {json.dumps(url)}, SUPABASE_ANON_KEY: {json.dumps(anon)}, DEPLOYMENT_MODE: 'WEB' }};\n"
    (OUT / "config" / ".env.js").write_text(public_config, encoding="utf-8")
    (OUT / ".htaccess").write_text(
        "Options -Indexes\n<FilesMatch \"^\\.(?!env\\.js$)\">\nRequire all denied\n</FilesMatch>\n"
        "<Files \"supabase-server.php\">\nRequire all denied\n</Files>\n", encoding="utf-8")
    (OUT / "config" / ".htaccess").write_text(
        "<Files \"supabase-server.php\">\nRequire all denied\n</Files>\n", encoding="utf-8")
    (OUT / "TimeInAndTimeOutMonitoring" / "students" / ".htaccess").write_text(
        "<FilesMatch \"\\.php$\">\nRequire all denied\n</FilesMatch>\n", encoding="utf-8")
    (OUT / "admin" / ".htaccess").write_text(
        "<Files \"admin-mfa-auth.php\">\nRequire all denied\n</Files>\n", encoding="utf-8")
    validate_assets()
    validate_no_server_secrets()
    forbidden = {".py", ".bat", ".npz", ".pth", ".onnx", ".xml", ".env"}
    unsafe = [p for p in OUT.rglob("*") if p.is_file() and p.suffix.lower() in forbidden]
    if unsafe:
        raise RuntimeError("Unsafe files in web package: " + ", ".join(str(p.relative_to(OUT)) for p in unsafe))
    print(f"Built {OUT} ({len(files)} source files; WEB mode; no local engines)")


if __name__ == "__main__":
    main()
