#!/usr/bin/env python3
"""
Download official Silent-Face-Anti-Spoofing resources for this project.

What it does:
1) Downloads pretrained model files into:
   students/models/
2) Downloads the entire upstream src/ folder into:
   src/
3) Verifies required files exist and prints a summary.
"""

from __future__ import annotations

import os
import sys
import time
import json
import pathlib
import urllib.request
import urllib.error


REPO_OWNER = "minivision-ai"
REPO_NAME = "Silent-Face-Anti-Spoofing"
REPO_BRANCH = "master"

ROOT_DIR = pathlib.Path(__file__).resolve().parent
MODELS_DIR = ROOT_DIR / "students" / "models"
SRC_DIR = ROOT_DIR / "src"

MODELS = [
    "2.7_80x80_MiniFASNetV2.pth",
    "4_0_0_80x80_MiniFASNetV1SE.pth",
]

MODELS_BASE_RAW = (
    f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{REPO_BRANCH}"
    "/resources/anti_spoof_models"
)

GITHUB_CONTENTS_API = (
    f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents"
)


class DownloadError(RuntimeError):
    pass


def _http_get_bytes(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "SAMS-AntiSpoof-Downloader/1.0",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _download_file(url: str, destination: pathlib.Path, retries: int = 3) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            data = _http_get_bytes(url, timeout=90)
            tmp = destination.with_suffix(destination.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(destination)
            return
        except Exception as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(1.2 * attempt)

    raise DownloadError(f"Failed to download {url}: {last_error}")


def _fetch_github_contents(path_in_repo: str) -> list[dict]:
    url = f"{GITHUB_CONTENTS_API}/{path_in_repo}?ref={REPO_BRANCH}"
    payload = _http_get_bytes(url, timeout=60)
    data = json.loads(payload.decode("utf-8"))
    if isinstance(data, dict) and data.get("type") == "file":
        return [data]
    if not isinstance(data, list):
        raise DownloadError(f"Unexpected GitHub API response for {path_in_repo}")
    return data


def _download_repo_dir(repo_dir: str, local_dir: pathlib.Path) -> int:
    """Recursively download a directory from GitHub contents API.

    Returns number of downloaded files.
    """
    entries = _fetch_github_contents(repo_dir)
    downloaded = 0

    for entry in entries:
        etype = entry.get("type")
        name = entry.get("name")
        path = entry.get("path")
        if not etype or not name or not path:
            continue

        if etype == "dir":
            downloaded += _download_repo_dir(path, local_dir)
            continue

        if etype == "file":
            download_url = entry.get("download_url")
            if not download_url:
                raise DownloadError(f"Missing download_url for {path}")

            relative = pathlib.Path(path).relative_to(repo_dir)
            target = local_dir / relative
            _download_file(download_url, target)
            downloaded += 1

    return downloaded


def _verify_required() -> tuple[bool, list[str]]:
    missing = []

    for model_name in MODELS:
        model_path = MODELS_DIR / model_name
        if not model_path.exists() or model_path.stat().st_size <= 0:
            missing.append(str(model_path))

    required_src_files = [
        SRC_DIR / "anti_spoof_predict.py",
        SRC_DIR / "default_config.py",
        SRC_DIR / "MiniFASNet.py",
    ]

    for req in required_src_files:
        if not req.exists() or req.stat().st_size <= 0:
            missing.append(str(req))

    return (len(missing) == 0, missing)


def main() -> int:
    print("=== Silent-Face-Anti-Spoofing setup ===")
    print(f"Project root: {ROOT_DIR}")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    SRC_DIR.mkdir(parents=True, exist_ok=True)

    print("\n[1/3] Downloading pretrained MiniFASNet weights...")
    for name in MODELS:
        url = f"{MODELS_BASE_RAW}/{name}"
        dest = MODELS_DIR / name
        print(f"  - {name}")
        _download_file(url, dest)

    print("\n[2/3] Downloading repository src/ folder...")
    file_count = _download_repo_dir("src", SRC_DIR)
    print(f"  - Downloaded {file_count} file(s) into {SRC_DIR}")

    print("\n[3/3] Verifying downloaded files...")
    ok, missing = _verify_required()
    if not ok:
        print("Verification failed. Missing files:")
        for item in missing:
            print(f"  - {item}")
        return 1

    print("\nSetup complete. MiniFASNet resources are ready.")
    print(f"Models path: {MODELS_DIR}")
    print(f"Source path: {SRC_DIR}")
    for model_name in MODELS:
        p = MODELS_DIR / model_name
        print(f"  - {p.name}: {p.stat().st_size} bytes")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted by user.")
        raise SystemExit(130)
