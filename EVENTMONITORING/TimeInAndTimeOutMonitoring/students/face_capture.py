import sys, os

# 1. Define the exact folder path
script_dir = os.path.dirname(os.path.abspath(__file__))

# 2. Redirect logs to a file so pythonw.exe never crashes silently
#    ── MODIFIED: also mirror everything to the real console (when one exists)
#    so you can watch the HOG/SVM/MediaPipe analytics live in the VS Code
#    terminal while still keeping the .txt log for pythonw.exe mode.
#    Set SHOW_TERMINAL_OUTPUT=0 to go back to file-only (silent) mode.
log_path = os.path.join(script_dir, "registration_log.txt")
_log_file_handle = open(log_path, "w", encoding="utf-8", buffering=1)
_console_stdout = sys.stdout  # None under pythonw.exe, a real stream under `python`/VS Code

class _TeeStream:
    """Writes to multiple streams at once (console + log file)."""
    def __init__(self, *streams):
        self.streams = [s for s in streams if s is not None]

    def write(self, data):
        for s in self.streams:
            try:
                s.write(data)
            except Exception:
                pass

    def flush(self):
        for s in self.streams:
            try:
                s.flush()
            except Exception:
                pass

if os.getenv("SHOW_TERMINAL_OUTPUT", "1") == "1" and _console_stdout is not None:
    sys.stdout = _TeeStream(_console_stdout, _log_file_handle)
else:
    sys.stdout = _log_file_handle
sys.stderr = sys.stdout

# 3. Load the hidden credentials safely
from dotenv import load_dotenv
env_path = os.path.join(script_dir, '.env')
load_dotenv(env_path, override=True)

# 4. Standard Imports
import time
import threading
import signal
import cv2
import numpy as np
import face_recognition
import mediapipe as mp
import requests
import datetime
import json
import dlib   # ← ADDED: needed to pull raw HOG+SVM detection scores for analytics

mp_selfie_segmentation = mp.solutions.selfie_segmentation

from flask import Flask, Response, request, jsonify
from flask_cors import CORS
from supabase import create_client, Client

# 5. Disable Flask logging
import logging
log = logging.getLogger('werkzeug')
log.disabled = True

# ==========================================
# SECURE CONFIGURATION
# ==========================================    
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
BUCKET_NAME = "facial_data"
ATTENDANCE_TRIGGER = os.getenv("ATTENDANCE_TRIGGER", "http://127.0.0.1:5000/trigger_rebuild")
ATTENDANCE_TRIGGER_TOKEN = (
    os.getenv("ATTENDANCE_TRIGGER_TOKEN")
    or os.getenv("REBUILD_SECRET")
    or ""
).strip()
CAMERA_OWNER_FILE = os.path.join(script_dir, "camera_owner.json")
CAMERA_OWNER_STALE_SECONDS = float(os.getenv("CAMERA_OWNER_STALE_SECONDS", "90"))
ENGINE_CAMERA_OWNER = "registration"

# ── ADDED: where pipeline-diagram snapshots get saved for the capstone paper ──
SNAPSHOT_DIR = os.path.join(script_dir, "pipeline_snapshots")
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

if not SUPABASE_URL or not SUPABASE_KEY:
    print(f"CRITICAL ERROR: Could not load credentials from {env_path}")
    sys.exit(1)

# Minimal audit stub so early startup logs can call `_audit_event` safely.
# The full XML audit implementation further down will override this.
import datetime as _dt
XML_LOG_FILE = os.path.join(script_dir, "engine_log.xml")
ENGINE_NAME = "face_capture"
ENGINE_LABEL = "Face Capture Engine"
ENGINE_INSTANCE_ID = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
def _log_hint(event_type, details=None):
    event_type = str(event_type)
    details = details if isinstance(details, dict) else {}
    phase = str(details.get("phase") or "").strip().lower()
    status_code = str(details.get("status_code") or "").strip()

    hints = {
        "startup": "The registration service started successfully and is ready to use.",
        "registration_started": "Face capture has started. Follow the camera prompts to register.",
        "upload_start": "Photos are being uploaded to cloud storage.",
        "registration_complete": "The photos finished uploading. The system is now asking the attendance engine to rebuild face data.",
        "trigger_rebuild_response": {
            "200": "The attendance engine accepted the rebuild request.",
            "409": "A rebuild is already running, so this request was skipped.",
            "401": "The attendance engine rejected the request because the secret token was not accepted.",
        },
        "error": "Something went wrong. Check the message below and make sure the required service or database is running.",
    }

    if event_type == "error" and phase == "trigger_rebuild":
        return "The attendance engine is not running or cannot be reached. Start it, then try registration again."
    if event_type == "error" and phase == "db_update":
        return "The database update failed. Check the Supabase connection and try again."
    if event_type == "trigger_rebuild_response":
        return hints["trigger_rebuild_response"].get(status_code, "The attendance engine returned a response. Check the details below.")
    return hints.get(event_type, "Check the details below for more information.")

def _ensure_xml_log():
    try:
        if not os.path.exists(XML_LOG_FILE):
            open(XML_LOG_FILE, "w", encoding="utf-8").write("<?xml version=\"1.0\" encoding=\"utf-8\"?><EngineLog version=\"1\"></EngineLog>")
    except Exception:
        pass

def _audit_event(event_type, details=None):
    try:
        # safe, minimal audit fallback: append a single-line entry to the plain registration log
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"[AUDIT-STUB] {_dt.datetime.now().isoformat()} {event_type} hint={_log_hint(event_type, details)} {details}\n")
    except Exception:
        pass

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
print("✓ Registration Supabase client ready")
_audit_event("startup", {"message": "Registration Supabase client ready"})

app = Flask(__name__)
CORS(app)

camera_owner_lock = threading.Lock()


def _read_camera_owner_state():
    try:
        if not os.path.exists(CAMERA_OWNER_FILE):
            return {"owner": None, "updated_at": 0}
        with open(CAMERA_OWNER_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        owner = str(data.get("owner") or "").strip().lower()
        updated_at = float(data.get("updated_at") or 0)
        if owner not in {"attendance", "registration"}:
            owner = None
        return {"owner": owner, "updated_at": updated_at}
    except Exception:
        return {"owner": None, "updated_at": 0}


def _write_camera_owner_state(owner):
    owner = str(owner or "").strip().lower()
    payload = {"owner": owner if owner in {"attendance", "registration"} else None, "updated_at": time.time()}
    tmp = CAMERA_OWNER_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, CAMERA_OWNER_FILE)
    return payload


def _is_owner_stale(updated_at):
    return (time.time() - float(updated_at or 0)) > CAMERA_OWNER_STALE_SECONDS


def _set_camera_owner(owner):
    with camera_owner_lock:
        return _write_camera_owner_state(owner)


def _claim_camera_owner(force=False):
    with camera_owner_lock:
        state = _read_camera_owner_state()
        owner = state.get("owner")
        if force or owner in (None, ENGINE_CAMERA_OWNER) or _is_owner_stale(state.get("updated_at")):
            return _write_camera_owner_state(ENGINE_CAMERA_OWNER), True
        return state, False


def _camera_owner_now():
    state = _read_camera_owner_state()
    return state.get("owner")


def _has_camera_owner():
    return _camera_owner_now() == ENGINE_CAMERA_OWNER

# Simple XML audit logger (writes to students/engine_log.xml)
import xml.etree.ElementTree as ET
XML_LOG_FILE = os.path.join(script_dir, "engine_log.xml")
XML_ARCHIVE_FILE = os.path.join(script_dir, "engine_log_archive.xml")
XML_MAX_EVENTS = int(os.getenv("ENGINE_LOG_MAX_EVENTS", "60"))

def _ensure_xml_log():
    try:
        if not os.path.exists(XML_LOG_FILE):
            root = ET.Element("EngineLog", version="1")
            tree = ET.ElementTree(root)
            tmp = XML_LOG_FILE + ".tmp"
            tree.write(tmp, encoding="utf-8", xml_declaration=True)
            os.replace(tmp, XML_LOG_FILE)
        if not os.path.exists(XML_ARCHIVE_FILE):
            root = ET.Element("EngineLog", version="1")
            tree = ET.ElementTree(root)
            tmp = XML_ARCHIVE_FILE + ".tmp"
            tree.write(tmp, encoding="utf-8", xml_declaration=True)
            os.replace(tmp, XML_ARCHIVE_FILE)
    except Exception as e:
        print(f"⚠ Failed to create XML log file: {e}")

def _append_events(target_path, events):
    tree = ET.parse(target_path)
    root = tree.getroot()
    for event in events:
        root.append(event)
    tmp = target_path + ".tmp"
    tree.write(tmp, encoding="utf-8", xml_declaration=True)
    os.replace(tmp, target_path)

def _archive_old_xml_events(max_events=XML_MAX_EVENTS):
    try:
        if max_events <= 0 or not os.path.exists(XML_LOG_FILE):
            return
        tree = ET.parse(XML_LOG_FILE)
        root = tree.getroot()
        events = list(root.findall("Event"))
        if len(events) <= max_events:
            return

        archive_count = len(events) - max_events
        old_events = events[:archive_count]
        keep_events = events[archive_count:]

        archive_tree = ET.parse(XML_ARCHIVE_FILE)
        archive_root = archive_tree.getroot()
        for event in old_events:
            archive_root.append(event)
        archive_tmp = XML_ARCHIVE_FILE + ".tmp"
        archive_tree.write(archive_tmp, encoding="utf-8", xml_declaration=True)
        os.replace(archive_tmp, XML_ARCHIVE_FILE)

        new_root = ET.Element("EngineLog", version=root.get("version", "1"))
        for event in keep_events:
            new_root.append(event)
        new_tree = ET.ElementTree(new_root)
        tmp = XML_LOG_FILE + ".tmp"
        new_tree.write(tmp, encoding="utf-8", xml_declaration=True)
        os.replace(tmp, XML_LOG_FILE)
    except Exception as e:
        print(f"⚠ Failed to archive old XML log events: {e}")

def _audit_event(event_type, details=None):
    try:
        _ensure_xml_log()
        tree = ET.parse(XML_LOG_FILE)
        root = tree.getroot()
        ev = ET.Element("Event", type=str(event_type), ts=datetime.datetime.now().isoformat())
        base_details = {
            "engine": ENGINE_NAME,
            "engine_label": ENGINE_LABEL,
            "engine_instance": ENGINE_INSTANCE_ID,
            "group_key": session.get("flow_id") or ENGINE_INSTANCE_ID,
            "group_label": session.get("flow_label") or ENGINE_LABEL,
        }
        if isinstance(details, dict):
            base_details.update(details)
        hint = ET.SubElement(ev, "Field", name="hint")
        hint.text = _log_hint(event_type, details)
        for k, v in base_details.items():
            if v is None or v == "":
                continue
            f = ET.SubElement(ev, "Field", name=str(k))
            f.text = str(v)
        if isinstance(details, dict):
            for k, v in details.items():
                if k in base_details:
                    continue
                f = ET.SubElement(ev, "Field", name=str(k))
                f.text = str(v)
        else:
            f = ET.SubElement(ev, "Field", name="message")
            f.text = str(details)
        root.append(ev)
        tmp = XML_LOG_FILE + ".tmp"
        tree.write(tmp, encoding="utf-8", xml_declaration=True)
        os.replace(tmp, XML_LOG_FILE)
        _archive_old_xml_events()
    except Exception as e:
        print(f"⚠ Failed to write XML audit event: {e}")

def _find_camera_index(preferred_range=(1, 4), fallback_index=0):
    """Prefer an external webcam first, then fall back to the laptop camera."""
    env_val = os.getenv("CAMERA_INDEX")
    if env_val:
        try:
            idx = int(env_val)
            cap_test = cv2.VideoCapture(idx)
            ok, _ = cap_test.read()
            cap_test.release()
            if ok:
                print(f"✓ Using camera index from CAMERA_INDEX={idx}")
                return idx
            print(f"⚠ CAMERA_INDEX={idx} is not usable, falling back to auto-detect")
        except Exception as exc:
            print(f"⚠ Invalid CAMERA_INDEX value '{env_val}': {exc}")

    start, end = preferred_range
    for idx in range(start, end + 1):
        try:
            cap_test = cv2.VideoCapture(idx)
            if not cap_test or not cap_test.isOpened():
                if cap_test:
                    cap_test.release()
                continue
            ok, _ = cap_test.read()
            cap_test.release()
            if ok:
                print(f"✓ Detected external webcam at index {idx}")
                return idx
        except Exception:
            continue

    try:
        cap_test = cv2.VideoCapture(fallback_index)
        ok, _ = cap_test.read()
        cap_test.release()
        if ok:
            print(f"✓ Falling back to laptop camera at index {fallback_index}")
            return fallback_index
    except Exception:
        pass

    print("⚠ No working camera found")
    return None


CAPTURE_CAMERA_INDEX = _find_camera_index(preferred_range=(1, 4), fallback_index=0)
if CAPTURE_CAMERA_INDEX is None:
    CAPTURE_CAMERA_INDEX = 0

cap = None
capture_thread = None
capture_running = False
latest_frame = None
capture_lock = threading.Lock()
CAPTURE_FRAME_WIDTH = int(os.getenv("CAMERA_FRAME_WIDTH", "640"))
CAPTURE_FRAME_HEIGHT = int(os.getenv("CAMERA_FRAME_HEIGHT", "480"))

# Initialize MediaPipe
mp_selfie_segmentation = mp.solutions.selfie_segmentation
segmentor = None

# ── ANALYTICS: raw dlib HOG+SVM detector, used only to print the SVM
#    confidence score alongside each detection (face_recognition's
#    high-level API does not expose this score) ──
_hog_detector = dlib.get_frontal_face_detector()


def _open_capture_device():
    if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
        return cv2.VideoCapture(CAPTURE_CAMERA_INDEX, cv2.CAP_DSHOW)
    return cv2.VideoCapture(CAPTURE_CAMERA_INDEX)


def _capture_worker():
    global latest_frame, capture_running

    while capture_running and cap is not None and cap.isOpened():
        success, frame = cap.read()
        if success:
            with capture_lock:
                latest_frame = frame
        else:
            time.sleep(0.01)


def _release_registration_camera():
    global cap, capture_running, latest_frame
    capture_running = False
    with capture_lock:
        latest_frame = None
    try:
        if cap is not None and cap.isOpened():
            cap.release()
    except Exception:
        pass
    cap = None

def ensure_capture_ready():
    global cap, segmentor, capture_thread, capture_running, latest_frame
    if not _has_camera_owner():
        return False
    if cap is None:
        cap = _open_capture_device()
        try:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_FRAME_WIDTH)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_FRAME_HEIGHT)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        except Exception:
            pass
        latest_frame = None
        capture_running = True
        if capture_thread is None or not capture_thread.is_alive():
            capture_thread = threading.Thread(target=_capture_worker, daemon=True)
            capture_thread.start()
    if segmentor is None:
        segmentor = mp_selfie_segmentation.SelfieSegmentation(model_selection=0)
    return cap is not None and cap.isOpened()

# Added countdown variables to the session state
session = {
    "id_number": None,
    "first_name": "",
    "last_name": "",
    "role": "student",   
    "count": 0,
    "active": False,
    "syncing": False,
    "completed": False,  
    "error_message": "",
    "paths": [],
    "last_t": 0,
    "done_t": 0,
    "countdown_done": False, 
    "align_start_t": 0,
    # ── ADDED: rolling history of accepted face centers, kept on the session
    #    so the /pipeline_snapshot route can reuse the *real* stability
    #    window instead of recomputing a fake one.
    "center_history": []
}


# =========================================================================
# ── ADDED: PIPELINE SNAPSHOT (for the capstone paper) ──
#
# This does NOT change how registration behaves. It's a diagnostic tool:
# grab whatever frame the camera currently sees, run it through every
# stage your paper describes (OpenCV resize -> OpenCV color convert ->
# dlib HOG+SVM -> alignment math -> stability window -> MediaPipe
# segmentation), and paste the intermediate results of every stage into
# ONE labeled PNG. That PNG is what you screenshot/insert in your paper.
# =========================================================================

def _panel(img, title, subtitle_lines, target_w=420, target_h=340):
    """Fit `img` into a target_w x target_h panel with a title bar and
    small text annotations underneath, so every stage renders at a
    consistent size in the final collage."""
    canvas = np.full((target_h, target_w, 3), 24, dtype=np.uint8)

    # Title bar
    cv2.rectangle(canvas, (0, 0), (target_w, 30), (50, 50, 50), -1)
    cv2.putText(canvas, title, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)

    # Reserve space for annotation text at the bottom
    text_h = 20 * max(1, len(subtitle_lines)) + 10
    img_area_h = target_h - 30 - text_h

    if img is not None and img.size > 0:
        ih, iw = img.shape[:2]
        scale = min(target_w / iw, img_area_h / ih)
        nw, nh = max(1, int(iw * scale)), max(1, int(ih * scale))
        resized = cv2.resize(img, (nw, nh))
        if resized.ndim == 2:
            resized = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
        if resized.shape[2] == 4:
            resized = cv2.cvtColor(resized, cv2.COLOR_BGRA2BGR)
        x_off = (target_w - nw) // 2
        y_off = 30 + (img_area_h - nh) // 2
        canvas[y_off:y_off + nh, x_off:x_off + nw] = resized

    y = target_h - text_h + 14
    for line in subtitle_lines:
        cv2.putText(canvas, line, (8, y), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (170, 230, 170), 1, cv2.LINE_AA)
        y += 20

    cv2.rectangle(canvas, (0, 0), (target_w - 1, target_h - 1), (90, 90, 90), 1)
    return canvas


def generate_pipeline_snapshot():
    """Runs the full detection/alignment/segmentation pipeline on ONE
    current frame and returns (success, path_or_error_message)."""

    with capture_lock:
        frame = None if latest_frame is None else latest_frame.copy()

    if frame is None:
        return False, "No camera frame is available yet. Start registration and make sure the camera is streaming first."

    h, w = frame.shape[:2]
    panels = []

    # ---- Stage 1: raw frame ----
    panels.append(_panel(
        frame, "1. Raw Frame Capture",
        [f"resolution: {w}x{h}px", "source: OpenCV VideoCapture (camera native, BGR)"]
    ))

    # ---- Stage 2: OpenCV resize (0.25x) ----
    t0 = time.time()
    small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
    resize_ms = (time.time() - t0) * 1000.0
    sh, sw = small.shape[:2]
    # upscale with nearest-neighbor just so the tiny 160x120 frame is visible in the panel
    small_display = cv2.resize(small, (sw * 3, sh * 3), interpolation=cv2.INTER_NEAREST)
    panels.append(_panel(
        small_display, "2. OpenCV Resize (cv2.resize, 0.25x)",
        [f"{w}x{h}px -> {sw}x{sh}px", f"resize_time={resize_ms:.1f}ms  (shown upscaled for visibility)"]
    ))

    # ---- Stage 3: color conversion BGR -> RGB ----
    t0 = time.time()
    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
    color_ms = (time.time() - t0) * 1000.0
    rgb_display = cv2.resize(rgb, (sw * 3, sh * 3), interpolation=cv2.INTER_NEAREST)
    # note: we feed this "RGB" array into an OpenCV imshow-style pipeline further down,
    # which itself expects BGR, so channels will look swapped here on purpose --
    # that swapped-color look IS the point: it visually proves the conversion happened.
    panels.append(_panel(
        rgb_display, "3. Color Conversion (BGR -> RGB)",
        [f"convert_time={color_ms:.1f}ms", "channel order swapped for dlib compatibility"]
    ))

    # ---- Stage 4: HOG + SVM detection ----
    t0 = time.time()
    rects, scores, _idx = _hog_detector.run(rgb, 1, 0)
    det_ms = (time.time() - t0) * 1000.0
    hog_display = frame.copy()
    last_locs = []
    best_score = None
    for i, (r, s) in enumerate(zip(rects, scores)):
        bx, by = r.left() * 4, r.top() * 4
        bw, bh = (r.right() - r.left()) * 4, (r.bottom() - r.top()) * 4
        last_locs.append((by, bx + bw, by + bh, bx))
        cv2.rectangle(hog_display, (bx, by), (bx + bw, by + bh), (0, 200, 255), 2)
        cv2.putText(hog_display, f"SVM={s:.3f}", (bx, max(15, by - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 200, 255), 2)
        if best_score is None or s > best_score:
            best_score = s
    hog_lines = [f"scan_time={det_ms:.1f}ms  faces_found={len(rects)}"]
    hog_lines.append(f"SVM_score={best_score:.4f} (>0 = face)" if best_score is not None else "no face in frame")
    panels.append(_panel(hog_display, "4. dlib HOG + SVM Detection", hog_lines))

    # ---- Stage 5: alignment check ----
    cx, cy = w // 2, h // 2
    rx, ry = int(w * 0.22), int(h * 0.38)
    align_display = frame.copy()
    cv2.ellipse(align_display, (cx, cy), (rx, ry), 0, 0, 360, (255, 255, 255), 2)

    align_lines = ["no face detected -- alignment not evaluated"]
    if last_locs:
        largest_face = max(last_locs, key=lambda rect: (rect[1] - rect[3]) * (rect[2] - rect[0]))
        t, r, b, l = largest_face
        face_cx, face_cy = (l + r) // 2, (t + b) // 2
        face_w = r - l
        normalized_dist = ((face_cx - cx) ** 2 / (rx ** 2)) + ((face_cy - cy) ** 2 / (ry ** 2))
        width_ratio = face_w / rx if rx else 0
        is_aligned = normalized_dist <= 0.4 and 1.3 <= width_ratio <= 1.8
        color = (0, 255, 0) if is_aligned else (0, 0, 255)
        cv2.ellipse(align_display, (cx, cy), (rx, ry), 0, 0, 360, color, 3)
        cv2.rectangle(align_display, (l, t), (r, b), color, 2)
        align_lines = [
            f"normalized_dist={normalized_dist:.3f} (need <=0.400)",
            f"width_ratio={width_ratio:.2f} (need 1.30-1.80)  -> {'ACCEPTED' if is_aligned else 'REJECTED'}"
        ]
    panels.append(_panel(align_display, "5. Alignment & Size Check", align_lines))

    # ---- Stage 6: stability window ----
    history = list(session.get("center_history", []))
    stab_display = np.full((300, 400, 3), 255, dtype=np.uint8)
    cv2.line(stab_display, (0, 150), (400, 150), (220, 220, 220), 1)
    cv2.line(stab_display, (200, 0), (200, 300), (220, 220, 220), 1)
    stab_lines = ["not enough samples yet (need >=5)"]
    if len(history) >= 2:
        xs = [p[0] for p in history]
        ys = [p[1] for p in history]
        base_x, base_y = xs[0], ys[0]
        pts = [(int(200 + (x - base_x)), int(150 + (y - base_y))) for x, y in zip(xs, ys)]
        for i in range(1, len(pts)):
            cv2.line(stab_display, pts[i - 1], pts[i], (255, 150, 0), 2)
        for p in pts:
            cv2.circle(stab_display, p, 4, (0, 100, 255), -1)
        if len(history) >= 5:
            max_dx = max(xs) - min(xs)
            max_dy = max(ys) - min(ys)
            steady = max_dx < 10 and max_dy < 10
            stab_lines = [
                f"max_dx={max_dx:.0f}px  max_dy={max_dy:.0f}px  (need <10px both)",
                f"-> {'STEADY' if steady else 'NOT STEADY'}   window_size={len(history)}"
            ]
        else:
            stab_lines = [f"window_size={len(history)}/5 samples collected"]
    panels.append(_panel(stab_display, "6. Stability Window (center history)", stab_lines))

    # ---- Stage 7: MediaPipe segmentation ----
    seg_lines = ["face not aligned -- segmentation not run"]
    final_rgba_display = np.full((300, 300, 3), 24, dtype=np.uint8)
    if last_locs and segmentor is not None:
        crop_t, crop_b = max(0, cy - ry), min(h, cy + ry)
        crop_l, crop_r = max(0, cx - rx), min(w, cx + rx)
        cropped_rect = frame[crop_t:crop_b, crop_l:crop_r]
        if cropped_rect.size != 0:
            rgb_crop = cv2.cvtColor(cropped_rect, cv2.COLOR_BGR2RGB)
            t0 = time.time()
            result = segmentor.process(rgb_crop)
            seg_ms = (time.time() - t0) * 1000.0

            person_mask = (result.segmentation_mask > 0.5).astype(np.uint8) * 255
            oval_mask = np.zeros(cropped_rect.shape[:2], dtype=np.uint8)
            local_cx, local_cy = cropped_rect.shape[1] // 2, cropped_rect.shape[0] // 2
            cv2.ellipse(oval_mask, (local_cx, local_cy), (rx, ry), 0, 0, 360, 255, -1)
            final_mask = cv2.bitwise_and(person_mask, oval_mask)

            raw_conf = result.segmentation_mask
            total_px = raw_conf.size
            person_px = int(np.sum(person_mask > 0))
            oval_px = int(np.sum(oval_mask > 0))
            final_px = int(np.sum(final_mask > 0))

            # build a 4-way mini composite: crop | person_mask | oval_mask | final result
            ch, cw = cropped_rect.shape[:2]
            mosaic = np.zeros((ch, cw * 4, 3), dtype=np.uint8)
            mosaic[:, 0:cw] = cropped_rect
            mosaic[:, cw:cw * 2] = cv2.cvtColor(person_mask, cv2.COLOR_GRAY2BGR)
            mosaic[:, cw * 2:cw * 3] = cv2.cvtColor(oval_mask, cv2.COLOR_GRAY2BGR)
            checker = np.indices((ch, cw)).sum(axis=0) % 16 < 8
            bg = np.where(checker[..., None], 60, 90).astype(np.uint8)
            bg = np.repeat(bg, 3, axis=2)
            result_rgb = cropped_rect.copy()
            alpha = (final_mask.astype(np.float32) / 255.0)[..., None]
            composited = (result_rgb.astype(np.float32) * alpha + bg.astype(np.float32) * (1 - alpha)).astype(np.uint8)
            mosaic[:, cw * 3:cw * 4] = composited
            final_rgba_display = mosaic

            seg_lines = [
                f"crop={cw}x{ch}px  inference={seg_ms:.1f}ms  mean_conf={raw_conf.mean():.3f}",
                f"person={person_px}/{total_px} ({person_px/total_px*100:.1f}%)  "
                f"final={final_px} ({final_px/oval_px*100 if oval_px else 0:.1f}% of oval)"
            ]
    panels.append(_panel(final_rgba_display, "7. MediaPipe Segmentation (crop | person mask | oval mask | RGBA result)",
                          seg_lines, target_w=420, target_h=340))

    # ---- Compose the final grid (4 columns x 2 rows) ----
    cols = 4
    rows = 2
    pw, ph = 420, 340
    grid = np.full((ph * rows + 60, pw * cols, 3), 15, dtype=np.uint8)
    cv2.putText(grid, "Face Registration Pipeline - Diagnostic Snapshot", (16, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(grid, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), (16, 55 * rows + ph * rows - ph * rows),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1, cv2.LINE_AA)

    for i, panel in enumerate(panels):
        r, c = divmod(i, cols)
        y0 = 60 + r * ph
        x0 = c * pw
        grid[y0:y0 + ph, x0:x0 + pw] = panel

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(SNAPSHOT_DIR, f"pipeline_snapshot_{timestamp}.png")
    cv2.imwrite(out_path, grid)
    print(f"[SNAPSHOT] Pipeline diagram saved -> {out_path}")
    _audit_event("pipeline_snapshot", {"path": out_path})
    return True, out_path


def upload_to_supabase():
    global session
    role = session.get("role", "student")

    try:
        requests.get(SUPABASE_URL, timeout=3)
    except requests.RequestException as exc:
        session["error_message"] = "REGISTRATION FAILED, INTERNET REQUIRED"
        session["syncing"] = False
        session["active"] = False
        print(f"[UPLOAD] Registration stopped: internet connection required ({exc})")
        _audit_event("error", {"phase": "internet_check", "error": str(exc)})
        return

    _audit_event("upload_start", {"id_number": session.get("id_number"), "role": role, "paths": ",".join(session.get("paths", []))})

    if role == "professor":
        cloud_folder = f"professors/professor_{session['id_number']}"
        table_name   = "professors"
        id_column    = "employee_id"
    else:
        cloud_folder = f"students/student_{session['id_number']}"
        table_name   = "students"
        id_column    = "stud_id"  # <-- CHANGED from "lrn" to "stud_id"

    # ── ANALYTICS: upload summary banner ──
    print("\n" + "=" * 60)
    print(f"[UPLOAD] Starting Supabase sync for {session.get('first_name')} {session.get('last_name')} (id={session.get('id_number')}, role={role})")
    print(f"[UPLOAD] Target folder: {cloud_folder}")
    print(f"[UPLOAD] Local files queued: {len(session['paths'])} -> {session['paths']}")

    valid_count = 0
    current_paths = list(session["paths"])

    for p in current_paths:
        if not os.path.exists(p): continue
        filename = os.path.basename(p)
        file_size_kb = os.path.getsize(p) / 1024.0
        try:
            t_up0 = time.time()
            with open(p, 'rb') as f:
                supabase.storage.from_(BUCKET_NAME).upload(
                    file=f, path=f"{cloud_folder}/{filename}",
                    file_options={"content-type": "image/png", "upsert": "true"}
                )
            up_ms = (time.time() - t_up0) * 1000
            valid_count += 1
            print(f"[UPLOAD]   ✓ {filename} ({file_size_kb:.1f} KB) uploaded in {up_ms:.0f}ms  -> {cloud_folder}/{filename}")
            os.remove(p)
        except Exception as e:
            print(f"[UPLOAD]   ✗ {filename} FAILED: {e}")

    print(f"[UPLOAD] Result: {valid_count}/{len(current_paths)} images uploaded successfully (need >=3 to finalize registration)")

    if valid_count >= 3:
        try:
            supabase.table(table_name).update({"facial_dataset_path": cloud_folder}).eq(id_column, session["id_number"]).execute()
            session["completed"] = True
            session["done_t"] = time.time()
            print(f"[UPLOAD] ✓ Database row updated: {table_name}.{id_column}={session['id_number']} -> facial_dataset_path='{cloud_folder}'")
            _audit_event("registration_complete", {"id_number": session.get("id_number"), "role": role, "uploaded": valid_count, "folder": cloud_folder})
            # Notify attendance engine (server-to-server) that encodings should be incrementally rebuilt.
            # If the attendance engine is not running, show a clear error so the operator knows what to fix.
            def _async_trigger(headers):
                try:
                    resp = requests.post(ATTENDANCE_TRIGGER, json={"force": False}, headers=headers, timeout=2.5)
                    if resp.status_code == 409:
                        friendly_text = "Rebuild already in progress. The attendance engine is already rebuilding, so this request was skipped."
                    elif resp.ok:
                        friendly_text = "Rebuild request accepted by the attendance engine."
                    else:
                        friendly_text = f"Rebuild request returned HTTP {resp.status_code}."

                    print(f"[UPLOAD] Trigger rebuild response: {resp.status_code} {friendly_text}")
                    try:
                        _audit_event("trigger_rebuild_response", {
                            "status_code": resp.status_code,
                            "message": friendly_text,
                            "text": resp.text[:200]
                        })
                    except Exception:
                        # If audit logging fails, still keep the rebuild flow running.
                        pass
                except Exception as exc:
                    friendly_msg = (
                        "Trigger rebuild failed: make sure the attendance engine is running "
                        f"before registering faces. Details: {exc}"
                    )
                    print(friendly_msg)
                    try:
                        _audit_event("error", {
                            "phase": "trigger_rebuild",
                            "error": friendly_msg,
                            "hint": "Make sure the attendance engine is running.",
                        })
                    except Exception:
                        pass

            headers = { 'Content-Type': 'application/json' }
            if ATTENDANCE_TRIGGER_TOKEN:
                headers['X-REBUILD-TOKEN'] = ATTENDANCE_TRIGGER_TOKEN
            threading.Thread(target=_async_trigger, args=(headers,), daemon=True).start()
        except Exception as e:
            print(f"DB Update Error: {e}")
            _audit_event("error", {"phase": "db_update", "error": str(e)})
    else:
        print(f"[UPLOAD] ✗ Registration NOT finalized — only {valid_count} valid image(s), 3 required.")

    print("=" * 60 + "\n")

    session["syncing"] = False
    session["count"] = 0
    session["paths"] = []

    
def generate_frames():
    ensure_capture_ready()

    frame_count = 0        
    process_every_n = 3    
    last_locs = []     
    
    # Track recent face center positions to measure stability
    center_history = []    

    while True:
        if not _has_camera_owner():
            _release_registration_camera()
            owner = _camera_owner_now() or "none"
            wait_frame = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(wait_frame, "Camera is assigned to another engine", (38, 220),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.62, (220, 220, 220), 2)
            cv2.putText(wait_frame, f"Current owner: {owner}", (38, 255),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (120, 190, 255), 2)
            _, buffer = cv2.imencode('.jpg', wait_frame)
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(0.08)
            continue

        if not ensure_capture_ready():
            wait_frame = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(wait_frame, "Unable to open camera", (180, 220),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.62, (220, 220, 220), 2)
            cv2.putText(wait_frame, "Check camera permissions/hardware", (145, 255),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (120, 190, 255), 2)
            _, buffer = cv2.imencode('.jpg', wait_frame)
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(0.12)
            continue

        with capture_lock:
            frame = None if latest_frame is None else latest_frame.copy()

        if frame is None:
            time.sleep(0.01)
            continue

        display = frame.copy()
        h, w = frame.shape[:2]

        if session["completed"]:
            if time.time() - session["done_t"] < 3.0:
                overlay = display.copy()
                cv2.rectangle(overlay, (0, 0), (w, h), (0, 150, 0), -1) 
                cv2.addWeighted(overlay, 0.3, display, 0.7, 0, display)
                
                cv2.putText(display, "REGISTRATION COMPLETE!", (w//2 - 180, h//2),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 3)
                cv2.putText(display, "Database Updated Successfully", (w//2 - 160, h//2 + 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 255, 200), 2)
            else:
                session["completed"] = False
                session["active"] = False

        elif session["syncing"]:
            overlay = display.copy()
            cv2.rectangle(overlay, (0, 0), (w, h), (0, 0, 0), -1)
            cv2.addWeighted(overlay, 0.4, display, 0.6, 0, display)
            
            cv2.putText(display, "SYNCING TO CLOUD...", (w//2 - 140, h//2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)
            
            bar_w = int((time.time() * 200) % 200)
            cv2.rectangle(display, (w//2 - 100, h//2 + 30), (w//2 - 100 + bar_w, h//2 + 40), (0, 255, 0), -1)

        elif session["active"]:
            if session["count"] < 5:
                
                if frame_count % process_every_n == 0:
                    # ── ANALYTICS: OpenCV preprocessing — resize ──
                    orig_h, orig_w = frame.shape[:2]
                    t_resize0 = time.time()
                    small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
                    resize_ms = (time.time() - t_resize0) * 1000.0
                    small_h, small_w = small.shape[:2]
                    print(f"[OPENCV-RESIZE] scan#{frame_count:05d}  "
                          f"raw_frame={orig_w}x{orig_h}px -> scaled_frame={small_w}x{small_h}px "
                          f"(scale=0.25x)  resize_time={resize_ms:.1f}ms")

                    # ── ANALYTICS: OpenCV preprocessing — color conversion ──
                    t_color0 = time.time()
                    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
                    color_ms = (time.time() - t_color0) * 1000.0
                    print(f"[OPENCV-COLOR]  scan#{frame_count:05d}  "
                          f"channel_order: BGR (camera native) -> RGB (required by dlib)  "
                          f"convert_time={color_ms:.1f}ms")

                    # ── ANALYTICS: run the raw dlib HOG+SVM detector directly so we
                    #    can print the bounding box AND the SVM confidence score for
                    #    every detection, exactly like the algorithm write-up. ──
                    t_det0 = time.time()
                    rects, scores, _idx = _hog_detector.run(rgb, 1, 0)
                    det_ms = (time.time() - t_det0) * 1000.0

                    last_locs = [(r.top() * 4, r.right() * 4, r.bottom() * 4, r.left() * 4) for r in rects]

                    if rects:
                        for i, (r, s) in enumerate(zip(rects, scores)):
                            print(f"[OPENCV-UPSCALE] scan#{frame_count:05d}  face#{i+1}  "
                                  f"detector_bbox_on_small=[x:{r.left()}, y:{r.top()}, "
                                  f"w:{r.right()-r.left()}, h:{r.bottom()-r.top()}]  "
                                  f"mapped_to_full_frame=[x:{r.left()*4}, y:{r.top()*4}, "
                                  f"w:{(r.right()-r.left())*4}, h:{(r.bottom()-r.top())*4}]  (×4 scale-back)")
                            
                        for i, (r, s) in enumerate(zip(rects, scores)):
                            bx = r.left() * 4
                            by = r.top() * 4
                            bw = (r.right() - r.left()) * 4
                            bh = (r.bottom() - r.top()) * 4
                            print(f"[HOG+SVM] scan#{frame_count:05d}  face#{i+1}  "
                                  f"bbox=[x:{bx}, y:{by}, w:{bw}, h:{bh}]  "
                                  f"SVM_score={s:.4f}  (>0 = face)  scan_time={det_ms:.1f}ms")
                    else:
                        print(f"[HOG+SVM] scan#{frame_count:05d}  no face in frame  scan_time={det_ms:.1f}ms")
                
                frame_count += 1

                cx, cy = w // 2, h // 2
                rx, ry = int(w * 0.22), int(h * 0.38) 
                axes = (rx, ry)
                
                is_aligned = False
                is_steady = False     
                aligned_face = None
                current_center = None 
                
                guidance_text = "Looking for face..." 

                if last_locs:
                    # Find the largest face in the frame
                    largest_face = max(last_locs, key=lambda rect: (rect[1]-rect[3])*(rect[2]-rect[0]))
                    t, r, b, l = largest_face
                    
                    face_cx = (l + r) // 2
                    face_cy = (t + b) // 2
                    face_w = r - l 
                    
                    if rx > 0 and ry > 0:
                        # 1. STRICTER CENTER CHECK: Must be very close to the center
                        normalized_dist = ((face_cx - cx)**2 / (rx**2)) + ((face_cy - cy)**2 / (ry**2))

                        # ── ANALYTICS: print the alignment math each time we test it ──
                        print(f"[ALIGN]   face_center=({face_cx},{face_cy})  target_center=({cx},{cy})  "
                              f"normalized_dist={normalized_dist:.3f} (must be <= 0.400)  "
                              f"face_width={face_w}px  oval_rx={rx}px  width_ratio={face_w/rx:.2f} "
                              f"(need 1.30-1.80)")

                        if normalized_dist <= 0.4:  # Reduced from 0.85
                            # 2. STRICTER SIZE CHECK: Force the user to fill the oval
                            if face_w < rx * 1.3:   # Increased from 0.9. Face must be wider
                                guidance_text = "Come closer! Fill the oval."
                                print(f"[ALIGN]   -> REJECTED: too far away (width_ratio {face_w/rx:.2f} < 1.30)")
                            elif face_w > rx * 1.8: # Face is too large
                                guidance_text = "Move back a little."
                                print(f"[ALIGN]   -> REJECTED: too close (width_ratio {face_w/rx:.2f} > 1.80)")
                            else:
                                is_aligned = True
                                aligned_face = (t, r, b, l)
                                current_center = (face_cx, face_cy)
                                print(f"[ALIGN]   -> ACCEPTED: face is centered and correctly sized")
                        else:
                            guidance_text = "Center your face exactly in the oval"
                            print(f"[ALIGN]   -> REJECTED: off-center (normalized_dist {normalized_dist:.3f} > 0.400)")
                
                # --- STABILITY CHECK ALGORITHM ---
                if is_aligned and current_center:
                    center_history.append(current_center)
                    if len(center_history) > 8: 
                        center_history.pop(0)
                    # ── ADDED: mirror the live history onto the session so the
                    #    /pipeline_snapshot route can draw the *real* stability graph
                    session["center_history"] = list(center_history)
                    
                    if len(center_history) >= 5:
                        cxs = [pt[0] for pt in center_history]
                        cys = [pt[1] for pt in center_history]
                        
                        max_movement_x = max(cxs) - min(cxs)
                        max_movement_y = max(cys) - min(cys)

                        # ── ANALYTICS: print the stability window each time it's evaluated ──
                        print(f"[STABILITY] window={center_history}  "
                              f"max_dx={max_movement_x}px  max_dy={max_movement_y}px  (must both be <10px)")

                        if max_movement_x < 10 and max_movement_y < 10: 
                            is_steady = True
                            print(f"[STABILITY] -> STEADY: countdown may proceed")
                        else:
                            print(f"[STABILITY] -> NOT STEADY: face is still moving, countdown resets")
                else:
                    center_history.clear() 
                    session["center_history"] = []
                # --------------------------------------

                # Guide turns Green only if Aligned AND Steady. Orange if moving.
                guide_color = (0, 255, 0) if (is_aligned and is_steady) else ((0, 165, 255) if is_aligned else (255, 255, 255))
                cv2.ellipse(display, (cx, cy), axes, 0, 0, 360, guide_color, 2)
                
                if not is_aligned:
                    text_size = cv2.getTextSize(guidance_text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)[0]
                    cv2.putText(display, guidance_text, (cx - text_size[0]//2, cy - ry - 20), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                    
                    for (t, r, b, l) in last_locs:
                        cv2.rectangle(display, (l, t), (r, b), (0, 0, 255), 2)

                    session["align_start_t"] = 0 
                    session["countdown_done"] = False
                
                # --- UNSTEADY WARNING ---
                elif not is_steady:
                    cv2.putText(display, "Hold still!", (cx - 45, cy - ry - 20), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 165, 255), 2)
                    t, r, b, l = aligned_face
                    cv2.rectangle(display, (l, t), (r, b), (0, 165, 255), 2)
                    
                    session["align_start_t"] = 0 
                    session["countdown_done"] = False
                
                # --- PROCEED (Aligned and Steady) ---
                else:
                    t, r, b, l = aligned_face
                    cv2.rectangle(display, (l, t), (r, b), (0, 255, 0), 2)
                    
                    # --- COUNTDOWN LOGIC ---
                    if not session.get("countdown_done", False):
                        if session.get("align_start_t", 0) == 0:
                            session["align_start_t"] = time.time()
                            
                        elapsed = time.time() - session["align_start_t"]
                        remaining = 2 - int(elapsed)
                        
                        if remaining > 0:
                            msg = "Hold steady, capturing in..."
                            msg_size = cv2.getTextSize(msg, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)[0]
                            msg_x = cx - (msg_size[0] // 2)
                            cv2.putText(display, msg, (msg_x, cy - ry - 45),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                            
                            num_str = str(remaining)
                            num_size = cv2.getTextSize(num_str, cv2.FONT_HERSHEY_SIMPLEX, 1.2, 3)[0]
                            num_x = cx - (num_size[0] // 2)
                            cv2.putText(display, num_str, (num_x, cy - ry - 10),
                                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 255), 3)
                        else:
                            session["countdown_done"] = True
                            session["last_t"] = 0 

                    # --- CAPTURE LOGIC ---
                    else:
                        cv2.putText(display, f"PHOTO {session['count']+1}/5", (l, t-10),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

                        if time.time() - session.get("last_t", 0) > 0.6:
                            for _ in range(3): cap.grab() 
                            
                            _, fresh_frame = cap.read()
                            
                            crop_t = max(0, cy - ry)
                            crop_b = min(h, cy + ry)
                            crop_l = max(0, cx - rx)
                            crop_r = min(w, cx + rx)
                            
                            cropped_rect = fresh_frame[crop_t:crop_b, crop_l:crop_r]
                            
                            if cropped_rect.size != 0:
                                rgb_crop = cv2.cvtColor(cropped_rect, cv2.COLOR_BGR2RGB)

                                # ── ANALYTICS: time the MediaPipe inference call ──
                                t_seg0 = time.time()
                                result = segmentor.process(rgb_crop)
                                seg_ms = (time.time() - t_seg0) * 1000.0

                                person_mask = (result.segmentation_mask > 0.5).astype(np.uint8) * 255
                                oval_mask = np.zeros(cropped_rect.shape[:2], dtype=np.uint8)
                                local_cx = cropped_rect.shape[1] // 2
                                local_cy = cropped_rect.shape[0] // 2
                                cv2.ellipse(oval_mask, (local_cx, local_cy), (rx, ry), 0, 0, 360, 255, -1)
                                
                                final_mask = cv2.bitwise_and(person_mask, oval_mask)

                                # ── ANALYTICS: quantify what MediaPipe actually decided ──
                                raw_conf = result.segmentation_mask
                                total_px = raw_conf.size
                                person_px = int(np.sum(person_mask > 0))
                                oval_px = int(np.sum(oval_mask > 0))
                                final_px = int(np.sum(final_mask > 0))
                                print(f"[MEDIAPIPE] SelfieSegmentation crop={cropped_rect.shape[1]}x{cropped_rect.shape[0]}px  "
                                      f"inference_time={seg_ms:.1f}ms  mean_confidence={raw_conf.mean():.3f}  "
                                      f"person_pixels={person_px}/{total_px} ({person_px/total_px*100:.1f}%)  "
                                      f"oval_pixels={oval_px}  final_masked_pixels={final_px} "
                                      f"({final_px/oval_px*100 if oval_px else 0:.1f}% of oval kept)")
                                
                                cropped_bgra = cv2.cvtColor(cropped_rect, cv2.COLOR_BGR2BGRA)
                                cropped_bgra[:, :, 3] = final_mask  
                                
                                p = f"{session['count'] + 1}.png"
                                cv2.imwrite(p, cropped_bgra)

                                file_kb = os.path.getsize(p) / 1024.0
                                print(f"[CAPTURE]   ✓ Photo {session['count'] + 1}/5 saved -> {p} "
                                      f"({cropped_bgra.shape[1]}x{cropped_bgra.shape[0]}px, {file_kb:.1f} KB, RGBA)")
                                
                                session["paths"].append(p)
                                session["count"] += 1
                                session["last_t"] = time.time()

            progress_w = int((session["count"] / 5) * (w - 40))
            cv2.rectangle(display, (20, h-40), (20+progress_w, h-20), (0, 255, 0), -1)
            cv2.rectangle(display, (20, h-40), (w-20, h-20), (255, 255, 255), 2)

            if session["count"] >= 5:
                session["syncing"] = True
                threading.Thread(target=upload_to_supabase).start()

        _, buffer = cv2.imencode('.jpg', display)
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')

@app.route('/start_registration', methods=['POST'])
def start_reg():
    global session
    try:
        requests.get(SUPABASE_URL, timeout=3)
    except requests.RequestException as exc:
        print(f"[REGISTRATION] Start rejected: internet connection required ({exc})")
        _audit_event("error", {"phase": "internet_check", "error": str(exc)})
        return jsonify({
            "status": "error",
            "error_message": "REGISTRATION FAILED, INTERNET REQUIRED"
        }), 503

    _claim_camera_owner(force=True)
    session['active'] = False 
    session['completed'] = False 
    
    for i in range(1, 6):
        for ext in [".jpg", ".png"]:
            if os.path.exists(f"{i}{ext}"):
                try: os.remove(f"{i}{ext}")
                except: pass

    data = request.json
    
    # Reset countdown variables on a fresh start
    session.update({
        "id_number": data['id_number'],
        "first_name": data['firstName'],
        "last_name": data['lastName'],
        "role": data.get('role', 'student'),
        "count": 0,
        "active": True,
        "error_message": "",
        "paths": [],
        "last_t": time.time(),
        "countdown_done": False, 
        "align_start_t": 0,
        "center_history": []
    })
    session["flow_id"] = f"registration::{session.get('id_number')}::{int(time.time())}"
    session["flow_label"] = f"Face Capture Registration {session.get('id_number')}"

    # ── ANALYTICS: session start banner ──
    print("\n" + "#" * 60)
    print(f"# REGISTRATION STARTED: {session['first_name']} {session['last_name']}  "
          f"(id={session['id_number']}, role={session['role']})")
    print("#" * 60 + "\n")

    _audit_event("registration_started", {"id_number": session.get("id_number"), "role": session.get("role")})
    return jsonify({"status": "ready"})

@app.route('/status')
def status(): 
    owner_state = _read_camera_owner_state()
    payload = dict(session)
    payload["camera_owner"] = owner_state.get("owner")
    payload["camera_owned_by_this_engine"] = owner_state.get("owner") == ENGINE_CAMERA_OWNER
    return jsonify(payload)


@app.route('/camera_control', methods=['GET', 'POST'])
def camera_control():
    if request.method == 'GET':
        state = _read_camera_owner_state()
        return jsonify({
            "success": True,
            "owner": state.get("owner"),
            "updated_at": state.get("updated_at"),
            "engine": ENGINE_CAMERA_OWNER,
            "owns_camera": state.get("owner") == ENGINE_CAMERA_OWNER,
        })

    data = request.get_json(silent=True) or {}
    target_owner = str(data.get("owner") or "").strip().lower()
    force = bool(data.get("force", True))
    if target_owner not in {"attendance", "registration"}:
        return jsonify({"success": False, "message": "owner must be attendance or registration"}), 400

    if target_owner == ENGINE_CAMERA_OWNER:
        state, changed = _claim_camera_owner(force=force)
    else:
        state = _set_camera_owner(target_owner)
        changed = True
        _release_registration_camera()

    return jsonify({
        "success": True,
        "owner": state.get("owner"),
        "updated_at": state.get("updated_at"),
        "engine": ENGINE_CAMERA_OWNER,
        "owns_camera": state.get("owner") == ENGINE_CAMERA_OWNER,
        "changed": bool(changed),
    })

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')


# ── ADDED: trigger + retrieve the pipeline diagnostic snapshot ──
@app.route('/pipeline_snapshot', methods=['POST'])
def pipeline_snapshot():
    """Runs the full pipeline once on the current frame and saves a single
    labeled PNG collage to pipeline_snapshots/. Call this while registration
    is active and your face is visible/aligned in the oval for the richest
    result (otherwise later stages will show 'not evaluated')."""
    if not ensure_capture_ready():
        return jsonify({"success": False, "message": "Camera is not currently owned by/available to the registration engine."}), 400
    ok, result = generate_pipeline_snapshot()
    if not ok:
        return jsonify({"success": False, "message": result}), 400
    filename = os.path.basename(result)
    return jsonify({"success": True, "path": result, "filename": filename, "url": f"/pipeline_snapshot_image/{filename}"})


@app.route('/pipeline_snapshot_image/<path:filename>')
def pipeline_snapshot_image(filename):
    """Serves a previously generated snapshot PNG directly in the browser,
    so you can open it and take a clean screenshot (or just use the PNG file
    itself in your paper)."""
    safe_path = os.path.join(SNAPSHOT_DIR, os.path.basename(filename))
    if not os.path.exists(safe_path):
        return jsonify({"success": False, "message": "Snapshot not found"}), 404
    with open(safe_path, 'rb') as f:
        data = f.read()
    return Response(data, mimetype='image/png')


@app.route('/shutdown', methods=['POST'])
def shutdown():
    global cap, capture_running, latest_frame
    try:
        _release_registration_camera()
    except Exception:
        pass
    os.kill(os.getpid(), signal.SIGTERM)
    return jsonify({"status": "shutting down"})

@app.route('/')
def index():
    return jsonify({"status": "running", "message": "Face Capture Engine is active"})

if __name__ == "__main__":
    app.run(host='127.0.0.1', port=5001, threaded=True)