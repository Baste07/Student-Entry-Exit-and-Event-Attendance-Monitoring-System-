import sys, os


# 1. Define the exact folder path
script_dir = os.path.dirname(os.path.abspath(__file__))

# 2. THE MAGIC FIX: Redirect all "screen" text into a log file so pythonw.exe doesn't crash!
log_path = os.path.join(script_dir, "engine_log.txt")
sys.stdout = open(log_path, "w", encoding="utf-8", buffering=1)
sys.stderr = sys.stdout # Send errors to the same file

# 3. Load the hidden credentials
from dotenv import load_dotenv
env_path = os.path.join(script_dir, '.env')
load_dotenv(env_path, override=True)

# 4. Standard Imports (Cleaned up, no duplicates)

import io, signal, warnings, datetime, queue, threading, json, time, hashlib
import urllib.request          # ← ADD THIS
import numpy as np
import cv2
import face_recognition
from concurrent.futures import ThreadPoolExecutor
try:
    import torch
except Exception:
    torch = None

    # ═════════════════════════════════════════════════════════════
# EVENT ATTENDANCE STATE
# ═════════════════════════════════════════════════════════════

student_details_cache = {}   # student_id -> {stud_id, grade_level, section_name}

timein_root_dir = os.path.dirname(script_dir)
anti_spoof_import_error = None

# Support both layouts:
# 1) .../TimeInAndTimeOutMonitoring/students/flask_attendance.py + ../src
# 2) .../TimeInAndTimeOutMonitoring/flask_attendance.py + ./src
for root in (script_dir, timein_root_dir):
    src_candidate = os.path.join(root, "src")
    if os.path.isdir(src_candidate):
        if root not in sys.path:
            sys.path.insert(0, root)
        if src_candidate not in sys.path:
            sys.path.insert(0, src_candidate)

try:
    from src.anti_spoof_predict import AntiSpoofPredict
    from src.generate_patches import CropImage
    from src.utility import parse_model_name
except Exception as exc_pkg:
    try:
        from anti_spoof_predict import AntiSpoofPredict
        from generate_patches import CropImage
        from utility import parse_model_name
    except Exception as exc_flat:
        AntiSpoofPredict = None
        CropImage = None
        parse_model_name = None
        anti_spoof_import_error = f"package import error: {exc_pkg} | flat import error: {exc_flat}"

if AntiSpoofPredict is not None and CropImage is not None and parse_model_name is not None:
    print("✓ Anti-spoof modules loaded successfully")
else:
    print(f"⚠ Anti-spoof module import failed: {anti_spoof_import_error}")


from flask import Flask, Response, request, jsonify
from flask_cors import CORS
from supabase import create_client, Client

warnings.filterwarnings("ignore", category=UserWarning, module="pkg_resources")
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

# 5. Disable Flask's aggressive logging that causes crashes in hidden mode
import logging
log = logging.getLogger('werkzeug')
log.disabled = True

# 6. Initialize Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
BUCKET_NAME  = "facial_data"
FACE_CACHE_FILE = os.path.join(script_dir, "face_encodings_cache.npz")
FACE_CACHE_VERSION = 2   # ← bumped to 2 so old v1 caches are auto-discarded
FORCE_FACE_CACHE_REBUILD = os.getenv("FORCE_FACE_CACHE_REBUILD", "0") == "1"
MAX_IMAGES_PER_PERSON = int(os.getenv("MAX_IMAGES_PER_PERSON", "1"))
REBUILD_SECRET = os.getenv("REBUILD_SECRET", "")
REBUILD_MIN_INTERVAL = float(os.getenv("REBUILD_MIN_INTERVAL", "3.0"))
AUTO_REBUILD_POLL_SECONDS = float(os.getenv("AUTO_REBUILD_POLL_SECONDS", "12.0"))

# MiniFASNet anti-spoof settings (official .pth weights + Silent-Face inference flow).
ANTI_SPOOF_ENABLED = os.getenv("ANTI_SPOOF_ENABLED", "1") == "1"
ANTI_SPOOF_MODEL_DIR = os.getenv("ANTI_SPOOF_MODEL_DIR", os.path.join(script_dir, "models"))
ANTI_SPOOF_MODEL_FILES = [
    p.strip() for p in os.getenv(
        "ANTI_SPOOF_MODEL_FILES",
        "2.7_80x80_MiniFASNetV2.pth,4_0_0_80x80_MiniFASNetV1SE.pth",
    ).split(",") if p.strip()
]
ANTI_SPOOF_THRESHOLD = float(os.getenv("ANTI_SPOOF_THRESHOLD", "0.5"))
ANTI_SPOOF_FAIL_CLOSED = os.getenv("ANTI_SPOOF_FAIL_CLOSED", "1") == "1"
ANTI_SPOOF_CACHE_TTL_SECONDS = float(os.getenv("ANTI_SPOOF_CACHE_TTL_SECONDS", "1.2"))
ANTI_SPOOF_DEVICE_ID = int(os.getenv("ANTI_SPOOF_DEVICE_ID", "0"))

CAMERA_OWNER_FILE = os.path.join(script_dir, "camera_owner.json")
CAMERA_OWNER_STALE_SECONDS = float(os.getenv("CAMERA_OWNER_STALE_SECONDS", "90"))
ENGINE_CAMERA_OWNER = "attendance"

if not SUPABASE_URL or not SUPABASE_KEY:
    print(f"CRITICAL ERROR: Could not load credentials from {env_path}")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
print("✓ Supabase client ready (Loaded from .env)")

app = Flask(__name__)
CORS(app)

attendee_clients = set()
attendee_clients_lock = threading.Lock()
recently_seen  = {}
COOLDOWN_SECS  = 5

# Face database state for fast startup.
face_db_lock = threading.Lock()
face_db_ready = threading.Event()
face_db_loading_started = False
engine_boot_lock = threading.Lock()
engine_boot_state = {
    "status": "booting",
    "face_db_phase": "starting",
    "data_source": "unknown",
    "cache_status": "unknown",
    "cache_file": FACE_CACHE_FILE,
    "cache_exists": os.path.exists(FACE_CACHE_FILE),
    "force_rebuild": FORCE_FACE_CACHE_REBUILD,
    "started_at": datetime.datetime.now().isoformat(),
    "last_update": datetime.datetime.now().isoformat(),
    "durations_ms": {},
    "encodings_loaded": 0,
    "error": None,
}

anti_spoof_lock = threading.Lock()
anti_spoof_runtime = {
    "predictor": None,
    "cropper": None,
    "model_paths": [],
    "device": "cpu",
}
anti_spoof_state = {
    "enabled": ANTI_SPOOF_ENABLED,
    "available": False,
    "model_dir": ANTI_SPOOF_MODEL_DIR,
    "model_files": list(ANTI_SPOOF_MODEL_FILES),
    "threshold": ANTI_SPOOF_THRESHOLD,
    "fail_closed": ANTI_SPOOF_FAIL_CLOSED,
    "message": "not_initialized",
    "last_error": None,
}
anti_spoof_cache = {}

EVENT_LATE_GRACE_MINUTES = 15

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

# Module-level face DB globals (must exist before any function uses them)
known_encodings    = []
known_meta         = []
known_encodings_np = None


def _init_anti_spoof():
    if not ANTI_SPOOF_ENABLED:
        anti_spoof_state.update({
            "available": False,
            "message": "disabled",
        })
        print("⚙ Anti-spoofing disabled (ANTI_SPOOF_ENABLED=0)")
        return

    if torch is None:
        anti_spoof_state.update({
            "available": False,
            "message": "torch_not_installed",
            "last_error": "PyTorch is not available",
        })
        print("⚠ Anti-spoofing unavailable: PyTorch is not installed")
        return

    if AntiSpoofPredict is None or CropImage is None or parse_model_name is None:
        anti_spoof_state.update({
            "available": False,
            "message": "import_failed",
            "last_error": "Could not import Silent-Face src modules",
        })
        print("⚠ Anti-spoofing unavailable: could not import Silent-Face src modules")
        return

    try:
        model_paths = []
        for model_name in ANTI_SPOOF_MODEL_FILES:
            p = os.path.join(ANTI_SPOOF_MODEL_DIR, model_name)
            if not os.path.exists(p):
                raise FileNotFoundError(f"Missing model file: {p}")
            model_paths.append(p)

        # AntiSpoofPredict.__init__ tries to load detection assets; if unavailable,
        # create an instance without Detection init because predict() only needs device.
        try:
            predictor = AntiSpoofPredict(ANTI_SPOOF_DEVICE_ID)
        except Exception:
            predictor = object.__new__(AntiSpoofPredict)
            predictor.device = torch.device(
                f"cuda:{ANTI_SPOOF_DEVICE_ID}" if torch.cuda.is_available() else "cpu"
            )

        cropper = CropImage()

        anti_spoof_runtime["predictor"] = predictor
        anti_spoof_runtime["cropper"] = cropper
        anti_spoof_runtime["model_paths"] = model_paths
        anti_spoof_runtime["device"] = str(getattr(predictor, "device", "cpu"))
        anti_spoof_state.update({
            "available": True,
            "message": "ready",
            "last_error": None,
        })
        print(f"✓ Anti-spoofing ready (official Silent-Face .pth, device={anti_spoof_runtime['device']})")
    except Exception as exc:
        anti_spoof_state.update({
            "available": False,
            "message": "model_load_failed",
            "last_error": str(exc),
        })
        print(f"⚠ Anti-spoofing model load failed: {exc}")


def _run_anti_spoof(frame_bgr, bbox):
    if not ANTI_SPOOF_ENABLED:
        return {"allowed": True, "is_live": True, "score": None, "reason": "disabled"}

    if not anti_spoof_state.get("available"):
        if ANTI_SPOOF_FAIL_CLOSED:
            return {"allowed": False, "is_live": False, "score": None, "reason": "service_unavailable"}
        return {"allowed": True, "is_live": True, "score": None, "reason": "service_unavailable_allowed"}

    if frame_bgr is None or bbox is None:
        if ANTI_SPOOF_FAIL_CLOSED:
            return {"allowed": False, "is_live": False, "score": None, "reason": "no_frame"}
        return {"allowed": True, "is_live": True, "score": None, "reason": "no_frame_allowed"}

    try:
        top, right, bottom, left = bbox
        x = max(0, int(left))
        y = max(0, int(top))
        w = max(1, int(right - left))
        h = max(1, int(bottom - top))
        image_bbox = [x, y, w, h]
        prediction = np.zeros((1, 3), dtype=np.float32)
        model_count = 0

        with anti_spoof_lock:
            predictor = anti_spoof_runtime.get("predictor")
            cropper = anti_spoof_runtime.get("cropper")
            model_paths = list(anti_spoof_runtime.get("model_paths") or [])
            if predictor is None or cropper is None or not model_paths:
                if ANTI_SPOOF_FAIL_CLOSED:
                    return {"allowed": False, "is_live": False, "score": None, "reason": "model_not_ready"}
                return {"allowed": True, "is_live": True, "score": None, "reason": "model_not_ready_allowed"}

        for model_path in model_paths:
            model_name = os.path.basename(model_path)
            h_input, w_input, _model_type, scale = parse_model_name(model_name)
            param = {
                "org_img": frame_bgr,
                "bbox": image_bbox,
                "scale": scale,
                "out_w": w_input,
                "out_h": h_input,
                "crop": True,
            }
            img = cropper.crop(**param)
            prediction += predictor.predict(img, model_path)
            model_count += 1

        if model_count <= 0:
            if ANTI_SPOOF_FAIL_CLOSED:
                return {"allowed": False, "is_live": False, "score": None, "reason": "no_models"}
            return {"allowed": True, "is_live": True, "score": None, "reason": "no_models_allowed"}

        combined_live_score = float(prediction[0][1] / float(model_count))
        is_live = combined_live_score >= ANTI_SPOOF_THRESHOLD
        pred_label = int(np.argmax(prediction, axis=1)[0])
        return {
            "allowed": bool(is_live),
            "is_live": bool(is_live),
            "score": round(combined_live_score, 4),
            "label": pred_label,
            "reason": "ok" if is_live else "spoof_detected",
        }
    except Exception as exc:
        anti_spoof_state["last_error"] = str(exc)
        if ANTI_SPOOF_FAIL_CLOSED:
            return {"allowed": False, "is_live": False, "score": None, "reason": "infer_error"}
        return {"allowed": True, "is_live": True, "score": None, "reason": "infer_error_allowed"}


def _run_anti_spoof_cached(face_key, frame_bgr, bbox):
    now_ts = time.time()
    cached = anti_spoof_cache.get(face_key)
    if cached and (now_ts - cached.get("ts", 0.0)) <= ANTI_SPOOF_CACHE_TTL_SECONDS:
        return cached.get("result")
    result = _run_anti_spoof(frame_bgr, bbox)
    anti_spoof_cache[face_key] = {"ts": now_ts, "result": result}
    if len(anti_spoof_cache) > 200:
        oldest = sorted(anti_spoof_cache.items(), key=lambda kv: kv[1].get("ts", 0.0))[:50]
        for k, _v in oldest:
            anti_spoof_cache.pop(k, None)
    return result

def _set_engine_boot_state(**updates):
    with engine_boot_lock:
        engine_boot_state.update(updates)
        engine_boot_state["last_update"] = datetime.datetime.now().isoformat()


_init_anti_spoof()

# Claim camera ownership only if it is currently unowned/stale.
_claim_camera_owner(force=False)

# Last rebuild summary visible via /engine_status
last_rebuild_summary = None
current_face_fingerprint = None

thread_pool = ThreadPoolExecutor(max_workers=3)


# ═════════════════════════════════════════════════════════════
# EMAIL STATUS TRACKING
# ═════════════════════════════════════════════════════════════
email_status_lock = threading.Lock()
email_status_log = []  # List of recent email send attempts
MAX_EMAIL_LOG = 50

def _log_email_status(student_id, event_id, email_type, success, message, details=None):
    """Log email send result for UI display."""
    entry = {
        "timestamp": datetime.datetime.now().isoformat(),
        "student_id": str(student_id),
        "event_id": str(event_id),
        "type": email_type,  # "time_in" or "time_out"
        "success": bool(success),
        "message": str(message),
        "details": details or {},
    }
    with email_status_lock:
        email_status_log.insert(0, entry)
        if len(email_status_log) > MAX_EMAIL_LOG:
            email_status_log.pop()
    status_emoji = "✓" if success else "✗"
    print(f"  {status_emoji} Email {email_type} | {message}")

def _hash_payload(obj) -> str:
    payload = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def _to_json_safe(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)

def _parse_event_start_datetime(event_row):
    event_date = event_row.get("event_date")
    time_start = event_row.get("time_start")
    if not event_date or not time_start:
        return None

    if isinstance(event_date, datetime.date):
        event_date_value = event_date
    else:
        event_date_value = datetime.date.fromisoformat(str(event_date))

    if isinstance(time_start, datetime.time):
        event_time_value = time_start
    else:
        event_time_value = datetime.time.fromisoformat(str(time_start))

    return datetime.datetime.combine(event_date_value, event_time_value)

def _event_late_minutes(event_row, scan_time):
    event_start = _parse_event_start_datetime(event_row)
    if not event_start or not scan_time:
        return 0

    grace_cutoff = event_start + datetime.timedelta(minutes=EVENT_LATE_GRACE_MINUTES)
    if scan_time <= grace_cutoff:
        return 0

    return int((scan_time - event_start).total_seconds() // 60)

def _send_attendance_email(student_id, event_id, timestamp_iso, meta, event_row,
                           email_type="time_in", time_in_recorded=None, duration_minutes=0):
    """Fire-and-forget email notification to the student via PHP endpoint."""
    payload = {
        "student_id": str(student_id),
        "event_id": str(event_id),
        "type": email_type,
        "timestamp": timestamp_iso,
        "email": meta.get("email"),
        "student_name": meta.get("name"),
        "stud_id": meta.get("stud_id"),
        "grade_level": meta.get("grade_level"),
        "section_name": meta.get("section_name"),
        "event_name": event_row.get("event_name"),
        "event_date": str(event_row.get("event_date")),
        "time_start": str(event_row.get("time_start")),
        "time_end": str(event_row.get("time_end")),
        "location": event_row.get("location"),
        "description": event_row.get("description"),
    }

    if email_type == "time_in":
        late = meta.get("late_minutes", 0)
        payload["late_minutes"] = late
        payload["status"] = "late" if late > 0 else "on-time"
    elif email_type == "time_out":
        payload["time_in_recorded"] = time_in_recorded
        payload["duration_minutes"] = duration_minutes

    # ── Validate we have an email ──
    student_email = meta.get("email")
    if not student_email:
        _log_email_status(
            student_id, event_id, email_type,
            success=False,
            message="No email on file for student",
            details={"student_name": meta.get("name")}
        )
        return

    try:
        req = urllib.request.Request(
            "http://localhost/CAPSTONEFINAL/EVENTMONITORING/TimeInAndTimeOutMonitoring/students/send_event_attendance_email.php",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(req, timeout=8)
        response_body = response.read().decode("utf-8")
        
        # Parse PHP response
        try:
            resp_json = json.loads(response_body)
            if resp_json.get("success"):
                _log_email_status(
                    student_id, event_id, email_type,
                    success=True,
                    message=resp_json.get("message", "Email sent"),
                    details={
                        "student_name": meta.get("name"),
                        "event_name": event_row.get("event_name"),
                        "to_email": student_email,
                    }
                )
            else:
                _log_email_status(
                    student_id, event_id, email_type,
                    success=False,
                    message=resp_json.get("message", "Unknown error from PHP"),
                    details={
                        "student_name": meta.get("name"),
                        "diagnostic": resp_json.get("diagnostic"),
                    }
                )
        except json.JSONDecodeError:
            _log_email_status(
                student_id, event_id, email_type,
                success=False,
                message="Invalid JSON response from PHP",
                details={"raw_response": response_body[:200]}
            )

    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        _log_email_status(
            student_id, event_id, email_type,
            success=False,
            message=f"HTTP {e.code}: {e.reason}",
            details={"response": error_body[:200]}
        )
    except Exception as e:
        _log_email_status(
            student_id, event_id, email_type,
            success=False,
            message=str(e),
            details={"error_type": type(e).__name__}
        )

def _list_face_images_for_folder(cloud_folder):
    last_error = None
    for attempt in range(3):
        try:
            files = supabase.storage.from_(BUCKET_NAME).list(cloud_folder)
            if not files:
                return []
            images = [
                f for f in files
                if str(f.get('name', '')).lower().endswith(('.jpg', '.jpeg', '.png'))
            ]
            return sorted(images, key=lambda x: x.get('name', ''))[:max(1, MAX_IMAGES_PER_PERSON)]
        except Exception as e:
            last_error = e
            wait_secs = 0.5 * (attempt + 1)
            print(f"    ⚠ Storage list failed for {cloud_folder} (attempt {attempt + 1}/3): {e}")
            time.sleep(wait_secs)
    print(f"    ✗ Giving up listing {cloud_folder}; using cached data if available. Last error: {last_error}")
    return []

# ─────────────────────────────────────────────────────────────────────────────
# PER-PERSON FINGERPRINT
# Each person gets their own fingerprint based only on their image metadata.
# This lets us detect exactly who changed without re-checking everyone.
# ─────────────────────────────────────────────────────────────────────────────
def _person_fingerprint(role, person_id, folder, images):
    """Build a fingerprint string for a single person's image set."""
    obj = {
        "role": role,
        "id":   str(person_id),
        "path": folder,
        "images": [
            {
                "name":       img.get("name"),
                "updated_at": _to_json_safe(img.get("updated_at")),
                "id":         _to_json_safe(img.get("id")),
            }
            for img in images
        ],
    }
    return _hash_payload(obj)

def _build_remote_face_manifest(students_rows, teachers_rows):
    manifest = []
    for row in students_rows:
        folder = row.get("facial_dataset_path")
        if not folder:
            continue
        folder_images = _list_face_images_for_folder(folder)
        manifest.append({
            "role": "student",
            "id": _to_json_safe(row.get("student_id")),
            "path": folder,
            "folder_signature": _hash_payload([
                {
                    "name": img.get("name"),
                    "updated_at": _to_json_safe(img.get("updated_at")),
                    "id": _to_json_safe(img.get("id")),
                }
                for img in folder_images
            ]),
        })
    for row in teachers_rows:
        folder = row.get("facial_dataset_path")
        if not folder:
            continue
        folder_images = _list_face_images_for_folder(folder)
        manifest.append({
            "role": "teacher",
            "id": _to_json_safe(row.get("teacher_id")),
            "path": folder,
            "folder_signature": _hash_payload([
                {
                    "name": img.get("name"),
                    "updated_at": _to_json_safe(img.get("updated_at")),
                    "id": _to_json_safe(img.get("id")),
                }
                for img in folder_images
            ]),
        })
    manifest.sort(key=lambda x: (x.get("role", ""), str(x.get("id", "")), x.get("path", "")))
    return manifest

def _build_remote_face_fingerprint(students_rows, teachers_rows):
    """Fingerprint only the facial dataset scope so unrelated DB edits do not trigger sync."""
    manifest = _build_remote_face_manifest(students_rows, teachers_rows)
    return _hash_payload(manifest), manifest

# ─────────────────────────────────────────────
# pgvector helpers
# ─────────────────────────────────────────────
def _vector_to_pg_literal(vec):
    return "[" + ",".join(f"{x:.8f}" for x in np.asarray(vec, dtype=np.float32)) + "]"

def _parse_pg_vector(raw):
    if raw is None:
        return None
    if isinstance(raw, list):
        return np.array(raw, dtype=np.float32)
    s = str(raw).strip().strip("[]")
    if not s:
        return None
    return np.array([float(x) for x in s.split(",")], dtype=np.float32)

def _upsert_face_embedding(role, person_id, embedding, fingerprint):
    table = "students" if role == "student" else "teachers"
    id_col = "student_id" if role == "student" else "teacher_id"
    try:
        supabase.table(table).update({
            "face_embedding": _vector_to_pg_literal(embedding),
            "face_embedding_fingerprint": fingerprint,
        }).eq(id_col, person_id).execute()
    except Exception as e:
        print(f"⚠ Failed to upsert pgvector embedding for {role}_{person_id}: {e}")

# ─────────────────────────────────────────────
# Cache load / save
# ─────────────────────────────────────────────
def _load_face_cache_from_disk():
    if not os.path.exists(FACE_CACHE_FILE):
        return None
    try:
        with np.load(FACE_CACHE_FILE, allow_pickle=False) as cache:
            version = int(cache["version"][0])
            if version != FACE_CACHE_VERSION:
                print(f"⚠ Face cache version mismatch ({version} != {FACE_CACHE_VERSION}); ignoring cache")
                return None
            encodings   = cache["encodings"]
            meta_json   = str(cache["meta_json"][0])
            fingerprint = str(cache["fingerprint"][0])
            saved_at    = str(cache["saved_at"][0])
            # NEW: per-person fingerprint map stored alongside main cache
            per_person_fp_json = str(cache["per_person_fp"][0]) if "per_person_fp" in cache else "{}"

        meta = json.loads(meta_json)
        per_person_fp = json.loads(per_person_fp_json)

        if encodings.size == 0:
            encodings = np.empty((0, 128), dtype=np.float32)
        elif encodings.ndim == 1:
            encodings = encodings.reshape(1, -1)

        return {
            "encodings":    encodings.astype(np.float32, copy=False),
            "meta":         meta,
            "fingerprint":  fingerprint,
            "saved_at":     saved_at,
            "per_person_fp": per_person_fp,   # { "student_<id>": "<hash>", ... }
        }
    except Exception as e:
        print(f"⚠ Face cache unreadable/corrupt: {e}. Rebuilding from source...")
        return None

def _save_face_cache_to_disk(encodings, meta, fingerprint, per_person_fp):
    try:
        tmp_path  = FACE_CACHE_FILE + ".tmp.npz"
        enc_np    = encodings if encodings is not None else np.empty((0, 128), dtype=np.float32)
        enc_np    = np.asarray(enc_np, dtype=np.float32)
        meta_json = json.dumps(meta, separators=(",", ":"), default=str)
        fp_json   = json.dumps(per_person_fp, separators=(",", ":"), default=str)

        np.savez_compressed(
            tmp_path,
            version=np.array([FACE_CACHE_VERSION], dtype=np.int32),
            encodings=enc_np,
            meta_json=np.array([meta_json]),
            fingerprint=np.array([fingerprint]),
            saved_at=np.array([datetime.datetime.now().isoformat()]),
            per_person_fp=np.array([fp_json]),   # ← NEW field
        )
        os.replace(tmp_path, FACE_CACHE_FILE)
        print(f"✓ Cache saved → {FACE_CACHE_FILE}")
    except Exception as e:
        print(f"⚠ Failed to save face cache: {e}")

def _activate_face_db(encodings, meta):
    global known_encodings, known_meta, known_encodings_np
    with face_db_lock:
        known_meta      = list(meta)
        known_encodings = [np.asarray(v, dtype=np.float32) for v in encodings] if len(encodings) else []
        known_encodings_np = np.asarray(encodings, dtype=np.float32) if len(encodings) else None

def _fetch_face_rows():
    students_result = supabase.table("students")\
.select("student_id, stud_id, first_name, middle_name, last_name, facial_dataset_path, section_id, face_embedding, face_embedding_fingerprint")\
        .not_.is_("facial_dataset_path", "null")\
        .neq("facial_dataset_path", "")\
        .execute()
    students_data = students_result.data or []

    teachers_data = []
    try:
        teachers_result = supabase.table("teachers")\
           .select("teacher_id, employee_id, first_name, middle_name, last_name, facial_dataset_path, face_embedding, face_embedding_fingerprint")\
            .not_.is_("facial_dataset_path", "null")\
            .neq("facial_dataset_path", "")\
            .execute()
        teachers_data = teachers_result.data or []
    except Exception as e:
        err_msg = str(e).lower()
        if "column" in err_msg and "facial_dataset_path" in err_msg:
            print("⚠ teachers.facial_dataset_path column not found — skipping teacher face recognition")
        else:
            print(f"⚠ Failed to fetch teachers: {e}")
        teachers_data = []

    return students_data, teachers_data

def load_encodings_from_storage(cloud_folder, meta, enc_store, meta_store):
    try:
        images = _list_face_images_for_folder(cloud_folder)
        if not images:
            print(f"    ✗ No files in: {cloud_folder}")
            return 0
        count = 0
        for img_file in images:
            file_path = f"{cloud_folder}/{img_file.get('name', '')}"
            try:
                img_bytes = supabase.storage.from_(BUCKET_NAME).download(file_path)
                nparr     = np.frombuffer(img_bytes, np.uint8)
                img       = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if img is None:
                    continue
                rgb_img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                encs = face_recognition.face_encodings(rgb_img)
                if encs:
                    enc_store.append(encs[0])
                    meta_store.append(meta)
                    count += 1
            except Exception as e:
                print(f"    ⚠ Error loading {img_file['name']}: {e}")
        return count
    except Exception as e:
        print(f"    ✗ Error accessing {cloud_folder}: {e}")
        return 0

# ═════════════════════════════════════════════════════════════════════════════
# INCREMENTAL FACE LOADER  ← THE KEY IMPROVEMENT
#
# How it works:
#   1. Load the existing cache from disk (fast).
#   2. Activate it immediately so the engine is usable right away.
#   3. Build per-person fingerprints from the DB metadata (no image downloads).
#   4. Compare each person's fingerprint against what's stored in the cache:
#        • Fingerprint matches  → keep cached encoding, skip download  ✅
#        • Fingerprint changed  → re-download & re-encode just this person 🔄
#        • Person is new        → download & encode for the first time  ➕
#        • Person was removed   → drop their encoding from the cache    ❌
#   5. Save updated cache to disk.
#
# Result: only the people who actually changed are re-processed.
# ═════════════════════════════════════════════════════════════════════════════



def _fetch_student_details(student_ids):
    """Fetch grade/section info for a list of student IDs from Supabase."""
    if not student_ids:
        return {}
    try:
        res = supabase.table("students")\
            .select("student_id, section_id, stud_id, email")\
            .in_("student_id", student_ids)\
            .execute()
        students = res.data or []

        section_ids = list({str(s["section_id"]) for s in students if s.get("section_id")})
        sections = {}
        if section_ids:
            sec_res = supabase.table("sections")\
                .select("section_id, grade_level, section_name")\
                .in_("section_id", section_ids)\
                .execute()
            for sec in sec_res.data or []:
                sections[str(sec["section_id"])] = sec

        mapping = {}
        for s in students:
            sid = str(s["student_id"])
            sec_id = str(s.get("section_id")) if s.get("section_id") else None
            sec_info = sections.get(sec_id) if sec_id else {}
            mapping[sid] = {
                "stud_id": s.get("stud_id"),
                "grade_level": sec_info.get("grade_level"),
                "section_name": sec_info.get("section_name"),
                "email": s.get("email"),  # ← ADD THIS
            }
        return mapping
        
    except Exception as e:
        print(f"⚠ Failed to fetch student details: {e}")
        return {}
    
def load_all_faces(force_rebuild=False):
    global known_encodings, known_meta, known_encodings_np, face_db_loading_started, last_rebuild_summary, current_face_fingerprint

    overall_t0 = time.perf_counter()
    face_db_ready.clear()
    _set_engine_boot_state(face_db_phase="starting", status="booting", error=None)

    with face_db_lock:
        if face_db_loading_started:
            return
        face_db_loading_started = True

    try:
        # ── STEP 1: Try to load cache from disk ──────────────────────────────
        cache_t0 = time.perf_counter()
        cached = None if force_rebuild else _load_face_cache_from_disk()
        _set_engine_boot_state(
            durations_ms={"cache_read": round((time.perf_counter() - cache_t0) * 1000, 2)}
        )

        if force_rebuild:
            print("⚙ FORCE_FACE_CACHE_REBUILD=1 → full rebuild from source")
            _set_engine_boot_state(cache_status="forced_rebuild", data_source="remote",
                                   face_db_phase="rebuilding")

        # Build working copies from cache (or empty if no cache / force rebuild)
        if cached and cached.get("meta") is not None:
            working_encodings  = list(cached["encodings"])   # list of np arrays
            working_meta       = list(cached["meta"])
            working_per_person = dict(cached.get("per_person_fp") or {})
            current_face_fingerprint = cached.get("fingerprint")

            # Activate cache immediately so face recognition works while we sync
            _activate_face_db(cached["encodings"], cached["meta"])
            face_db_ready.set()
            _set_engine_boot_state(
                cache_status="loaded",
                data_source="cache",
                face_db_phase="validating",
                encodings_loaded=len(cached["meta"]),
            )
            print(f"✓ Cache loaded from disk ({len(cached['meta'])} encodings) — validating against DB…")
            # Continue to validate against remote DB/storage to ensure the cache matches
            # the authoritative source. This may take time during startup but guarantees
            # correctness and ensures consistency with the database.
        else:
            working_encodings  = []
            working_meta       = []
            working_per_person = {}
            _set_engine_boot_state(cache_status="missing_or_invalid", data_source="remote",
                                   face_db_phase="rebuilding")
            print("⚙ No valid cache — building from source")

        # ── STEP 2: Fetch DB metadata rows (no image downloads yet) ──────────
        _set_engine_boot_state(face_db_phase="validating")
        fp_t0 = time.perf_counter()
        students_rows, teachers_rows = _fetch_face_rows()
                # Build student grade/section cache
        student_ids = [str(r["student_id"]) for r in students_rows if r.get("student_id")]
        global student_details_cache
        student_details_cache = _fetch_student_details(student_ids)

        # If we had no usable local cache, seed working arrays from pgvector so we
        # don't have to re-download every photo on a fresh machine.
        if not cached:
            for row in students_rows:
                vec = _parse_pg_vector(row.get("face_embedding"))
                fp_db = row.get("face_embedding_fingerprint")
                if vec is not None and fp_db:
                    mid = row.get("middle_name") or ""
                    details = student_details_cache.get(str(row["student_id"]), {})
                    working_encodings.append(vec)
                    working_meta.append({
                        "role": "student",
                        "id": row["student_id"],
                        "stud_id": details.get("stud_id"),
                        "name": f"{row['first_name']} {mid} {row['last_name']}".strip(),
                        "grade_level": details.get("grade_level"),
                        "section_name": details.get("section_name"),
                        "email": details.get("email"),
                    })
                    working_per_person[f"student_{row['student_id']}"] = fp_db
            for row in teachers_rows:
                vec = _parse_pg_vector(row.get("face_embedding"))
                fp_db = row.get("face_embedding_fingerprint")
                if vec is not None and fp_db:
                    mid = row.get("middle_name") or ""
                    working_encodings.append(vec)
                    working_meta.append({
                        "role": "teacher",
                        "id": row["teacher_id"],
                        "employee_id": row["employee_id"],
                        "name": f"{row['first_name']} {mid} {row['last_name']}".strip(),
                    })
                    working_per_person[f"teacher_{row['teacher_id']}"] = fp_db
            if working_meta:
                print(f"✓ Seeded {len(working_meta)} encodings from pgvector (no local cache present)")

        # Build the facial-path fingerprint (used to detect only face dataset path changes)
        try:
            remote_fingerprint, _ = _build_remote_face_fingerprint(students_rows, teachers_rows)
        except Exception as e:
            # If Supabase storage is temporarily slow, keep the current cache alive.
            print(f"⚠ Remote fingerprint build failed; keeping cached encodings active: {e}")
            if cached and cached.get("meta") is not None:
                with engine_boot_lock:
                    d = dict(engine_boot_state.get("durations_ms") or {})
                    d["total_startup"] = round((time.perf_counter() - overall_t0) * 1000, 2)
                _set_engine_boot_state(
                    status="ready",
                    face_db_phase="ready",
                    cache_status="validated_with_fallback",
                    data_source="cache",
                    durations_ms=d,
                    encodings_loaded=len(cached["meta"]),
                    cache_exists=os.path.exists(FACE_CACHE_FILE),
                    error=str(e),
                )
                print("✓ Falling back to cached face encodings because storage validation timed out")
                try:
                    last_rebuild_summary = {
                        "timestamp": datetime.datetime.now().isoformat(),
                        "duration_ms": float(d.get("total_startup", 0)),
                        "added": 0,
                        "updated": 0,
                        "removed": 0,
                        "kept": len(cached.get("meta") or []),
                        "note": "fallback_to_cache",
                    }
                    print(f"REBUILD SUMMARY (fallback): {last_rebuild_summary}")
                except Exception:
                    pass
                # Ensure globals are set from cache before returning
                _activate_face_db(cached["encodings"], cached["meta"])
                return
            raise
        with engine_boot_lock:
            d = dict(engine_boot_state.get("durations_ms") or {})
            d["fingerprint_build"] = round((time.perf_counter() - fp_t0) * 1000, 2)
        _set_engine_boot_state(durations_ms=d)

        # If nothing changed at all, we're done immediately ──────────────────
        if cached and cached.get("fingerprint") == remote_fingerprint:
            current_face_fingerprint = remote_fingerprint
            with engine_boot_lock:
                d = dict(engine_boot_state.get("durations_ms") or {})
                d["total_startup"] = round((time.perf_counter() - overall_t0) * 1000, 2)
            _set_engine_boot_state(
                status="ready", face_db_phase="ready", cache_status="validated",
                data_source="cache", durations_ms=d,
                cache_exists=os.path.exists(FACE_CACHE_FILE),
            )
            print("✓ Face cache fingerprint matched — no changes detected")
            print(f"✓ Startup timings (ms): {d}")
            # Record a small rebuild summary (no changes)
            try:
                last_rebuild_summary = {
                    "timestamp": datetime.datetime.now().isoformat(),
                    "duration_ms": float(d.get("total_startup", 0)),
                    "added": 0,
                    "updated": 0,
                    "removed": 0,
                    "kept": len(cached.get("meta") or []),
                    "note": "no_changes",
                }
                print(f"REBUILD SUMMARY: {last_rebuild_summary}")
            except Exception:
                pass
            print("=" * 60)
            return

        # ── STEP 3: Incremental sync — only process what changed ─────────────
        print("⚙ Changes detected — running incremental sync…")
        _set_engine_boot_state(face_db_phase="rebuilding")

        rebuild_t0 = time.perf_counter()
        added = updated = removed = kept = 0

        # Build the set of person keys that exist remotely right now
        # Key format:  "student_<student_id>"  or  "teacher_<teacher_id>"
        remote_keys = set()

        all_remote_rows = []
        for row in students_rows:
            folder = row.get("facial_dataset_path")
            if not folder:
                continue
            images     = _list_face_images_for_folder(folder)
            person_key = f"student_{row['student_id']}"
            remote_keys.add(person_key)
            new_fp     = _person_fingerprint("student", row["student_id"], folder, images)
            all_remote_rows.append({
                "key":    person_key,
                "role":   "student",
                "row":    row,
                "folder": folder,
                "images": images,
                "fp":     new_fp,
            })

        for row in teachers_rows:
            folder = row.get("facial_dataset_path")
            if not folder:
                continue
            images     = _list_face_images_for_folder(folder)
            person_key = f"teacher_{row['teacher_id']}"
            remote_keys.add(person_key)
            new_fp     = _person_fingerprint("teacher", row["teacher_id"], folder, images)
            all_remote_rows.append({
                "key":    person_key,
                "role":   "teacher",
                "row":    row,
                "folder": folder,
                "images": images,
                "fp":     new_fp,
            })

        # ── STEP 3a: REMOVE people no longer in the DB ───────────────────────
        # Build a lookup: person_key → list of indices in working arrays
        def _build_key_index(meta_list):
            idx = {}
            for i, m in enumerate(meta_list):
                k = f"{m['role']}_{m['id']}"
                idx.setdefault(k, []).append(i)
            return idx

        key_index = _build_key_index(working_meta)

        # Collect indices to REMOVE (people who were deleted from DB)
        indices_to_remove = set()
        for key, idxs in key_index.items():
            if key not in remote_keys:
                for i in idxs:
                    indices_to_remove.add(i)
                working_per_person.pop(key, None)
                removed += 1
                print(f"    ❌ REMOVED  {key}")

        if indices_to_remove:
            # Rebuild working arrays without the removed indices
            keep = [i for i in range(len(working_meta)) if i not in indices_to_remove]
            working_encodings = [working_encodings[i] for i in keep]
            working_meta      = [working_meta[i]      for i in keep]
            # Rebuild index after removal
            key_index = _build_key_index(working_meta)

        # ── STEP 3b: ADD new people / UPDATE changed people ──────────────────
        for entry in all_remote_rows:
            person_key = entry["key"]
            new_fp     = entry["fp"]
            cached_fp  = working_per_person.get(person_key)

            if cached_fp == new_fp:
                # Fingerprint unchanged — skip entirely, encoding already in cache
                kept += 1
                continue

            row    = entry["row"]
            folder = entry["folder"]
            is_new = person_key not in key_index

            if entry["role"] == "student":
                mid  = row.get("middle_name") or ""
                details = student_details_cache.get(str(row["student_id"]), {})
                meta = {
                    "role":        "student",
                    "id":          row["student_id"],
                    "stud_id":     row["stud_id"],
                    "name":        f"{row['first_name']} {mid} {row['last_name']}".strip(),
                    "stud_id":     details.get("stud_id"),
                    "grade_level": details.get("grade_level"),
                    "section_name":details.get("section_name"),
                    "email":       details.get("email"),  # ← ADD THIS
                }
            else:
                mid  = row.get("middle_name") or ""
                meta = {
                    "role":        "teacher",
                    "id":          row["teacher_id"],
                    "employee_id": row["employee_id"],
                    "name":        f"{row['first_name']} {mid} {row['last_name']}".strip(),
                }

            # If updating an existing person, remove their old encodings first
            if not is_new:
                old_indices = key_index.get(person_key, [])
                keep = [i for i in range(len(working_meta)) if i not in set(old_indices)]
                working_encodings = [working_encodings[i] for i in keep]
                working_meta      = [working_meta[i]      for i in keep]
                key_index = _build_key_index(working_meta)

            # Download & encode the new/updated images
            new_encs  = []
            new_metas = []
            n = load_encodings_from_storage(folder, meta, new_encs, new_metas)

            if n > 0:
                working_encodings.extend(new_encs)
                working_meta.extend(new_metas)
                working_per_person[person_key] = new_fp   # store new fingerprint
                key_index = _build_key_index(working_meta)

                avg_embedding = np.mean(np.array(new_encs, dtype=np.float32), axis=0)
                _upsert_face_embedding(entry["role"], meta["id"], avg_embedding, new_fp)

                if is_new:
                    added += 1
                    print(f"    ➕ ADDED    {meta['name']} ({n} enc)")
                else:
                    updated += 1
                    print(f"    🔄 UPDATED  {meta['name']} ({n} enc)")
            else:
                # No encodable face found — don't store a broken fingerprint
                working_per_person.pop(person_key, None)
                if is_new:
                    # Never had encodings, still doesn't — just warn
                    print(f"    ⚠ SKIPPED (no face in storage) {meta['name']}")
                else:
                    # Had encodings before, now storage is empty → treat as removed
                    removed += 1
                    print(f"    ❌ REMOVED  {meta['name']} (files deleted from storage)")

        # ── STEP 4: Activate updated DB and save cache ───────────────────────
        enc_np = (np.array(working_encodings, dtype=np.float32)
                  if working_encodings
                  else np.empty((0, 128), dtype=np.float32))

        _activate_face_db(enc_np, working_meta)
        _save_face_cache_to_disk(enc_np, working_meta, remote_fingerprint, working_per_person)
        current_face_fingerprint = remote_fingerprint

        with engine_boot_lock:
            d = dict(engine_boot_state.get("durations_ms") or {})
            d["rebuild_encode"] = round((time.perf_counter() - rebuild_t0) * 1000, 2)
            d["total_startup"]  = round((time.perf_counter() - overall_t0) * 1000, 2)

        _set_engine_boot_state(
            status="ready", face_db_phase="ready",
            cache_status="incremental_update",
            data_source="remote" if (added + updated + removed) > 0 else "cache",
            durations_ms=d,
            encodings_loaded=len(working_meta),
            cache_exists=os.path.exists(FACE_CACHE_FILE),
        )

        print(f"\n✓ Incremental sync complete — "
              f"➕{added} added  🔄{updated} updated  ❌{removed} removed  ✅{kept} unchanged")
        print(f"✓ Total encodings in memory: {len(working_meta)}")
        print(f"✓ Startup timings (ms): {d}")
        # Record concise rebuild summary for UI/metrics
        try:
            last_rebuild_summary = {
                "timestamp": datetime.datetime.now().isoformat(),
                "duration_ms": float(d.get("rebuild_encode", d.get("total_startup", 0))),
                "added": int(added),
                "updated": int(updated),
                "removed": int(removed),
                "kept": int(kept),
            }
            print(f"REBUILD SUMMARY: {last_rebuild_summary}")
        except Exception:
            pass

    except Exception as e:
        with engine_boot_lock:
            d = dict(engine_boot_state.get("durations_ms") or {})
            d["total_startup"] = round((time.perf_counter() - overall_t0) * 1000, 2)
        _set_engine_boot_state(status="ready", face_db_phase="error", error=str(e), durations_ms=d)
        print(f"⚠ Failed to build face database at startup: {e}")
        import traceback; traceback.print_exc()
    finally:
        with face_db_lock:
            loaded = len(known_meta) if 'known_meta' in globals() else 0
            face_db_loading_started = False
        _set_engine_boot_state(encodings_loaded=loaded, cache_exists=os.path.exists(FACE_CACHE_FILE))
        face_db_ready.set()
        print("=" * 60)

# ─────────────────────────────────────────────
# Shared state for threading
# ─────────────────────────────────────────────
frame_lock         = threading.Lock()
result_lock        = threading.Lock()
latest_frame       = None
recognition_result = {"locations": [], "labels": [], "colors": []}

def get_guide_bounds(frame_shape):
    h, w = frame_shape[:2]
    guide_w = int(w * 0.45)
    guide_h = int(h * 0.62)
    x1 = (w - guide_w) // 2
    y1 = (h - guide_h) // 2
    x2 = x1 + guide_w
    y2 = y1 + guide_h
    return x1, y1, x2, y2

def _handle_recognition(meta):
    """Called by the recognition worker when a known face passes liveness."""
    if meta.get("role") != "student":
        _push({
            "message": f"HELLO {meta['name']}",
            "name": meta["name"],
            "type": "greeting_only",
            "role": "teacher"
        })
        return
    # Offload the DB write to the thread pool so the video loop never blocks
    thread_pool.submit(_record_event_attendance, meta["id"], meta)


def _record_event_attendance(student_id, meta):
    """
    Auto-detect event from the student's participation list.
    Priority: ongoing → completed → upcoming.
    """
    try:
        # 1. Find every event this student is registered for
        part_res = supabase.table("event_participants")\
            .select("event_id")\
            .eq("student_id", student_id)\
            .execute()
        event_ids = [p["event_id"] for p in part_res.data] if part_res.data else []

        if not event_ids:
            _push({
                "message": "NOT REGISTERED",
                "name": meta["name"],
                "type": "not_participant",
                "reason": "You are not registered for any event."
            })
            return

        # 2. Pull those events, newest first
        ev_res = supabase.table("events")\
            .select("*")\
            .in_("event_id", event_ids)\
            .in_("status", ["ongoing", "completed", "upcoming"])\
            .order("event_date", desc=True)\
            .order("time_start", desc=True)\
            .execute()
        events = ev_res.data or []

        if not events:
            _push({
                "message": "NO ACTIVE EVENT",
                "name": meta["name"],
                "type": "error",
                "reason": "No active or completed event found."
            })
            return

        now = datetime.datetime.now(datetime.timezone.utc)
        now_local = datetime.datetime.now()
        ongoing   = [e for e in events if e.get("status") == "ongoing"]
        completed = [e for e in events if e.get("status") == "completed"]
        upcoming  = [e for e in events if e.get("status") == "upcoming"]

        # ═══════════════════════════════════════════════════
        # PRIORITY 1: ONGOING → time_in
        # ═══════════════════════════════════════════════════
        if ongoing:
            ev    = ongoing[0]
            ev_id = ev["event_id"]
            late_minutes = _event_late_minutes(ev, now_local)
            attendance_remarks = f"Late by {late_minutes} min" if late_minutes > 0 else "On time"

            att_res = supabase.table("event_attendance")\
                .select("*")\
                .eq("event_id", ev_id)\
                .eq("student_id", student_id)\
                .execute()
            row = att_res.data[0] if att_res.data else None

            if not row:
                supabase.table("event_attendance").insert({
                    "event_id": ev_id,
                    "student_id": student_id,
                    "time_in": now.isoformat(),
                    "remarks": attendance_remarks,
                    "verified_by_facial_recognition": True,
                }).execute()

                    # ── SEND TIME-IN EMAIL ──
                meta["late_minutes"] = late_minutes
                thread_pool.submit(
                    _send_attendance_email,
                    student_id, ev_id, now.isoformat(), meta, ev,
                    email_type="time_in"
                )
                _push({
                    "message": f"TIME IN {meta['name']}",
                    "name": meta["name"],
                    "type": "time_in",
                    "time": now.strftime("%I:%M %p"),
                    "grade": meta.get("grade_level", ""),
                    "section": meta.get("section_name", ""),
                    "stud_id": meta.get("stud_id", ""),
                    "event_name": ev.get("event_name", ""),
                    "late_minutes": late_minutes,
                    "attendance_status": "late" if late_minutes > 0 else "on-time",
                })
                return

            elif row and not row.get("time_out"):
                _push({
                    "message": "ALREADY TIMED IN",
                    "name": meta["name"],
                    "type": "already_recorded",
                    "grade": meta.get("grade_level", ""),
                    "section": meta.get("section_name", ""),
                    "stud_id": meta.get("stud_id", ""),
                    "event_name": ev.get("event_name", ""),
                    "reason": "You have already timed in for this event."
                })
                return

            else:
                _push({
                    "message": "ATTENDANCE COMPLETE",
                    "name": meta["name"],
                    "type": "already_recorded",
                    "grade": meta.get("grade_level", ""),
                    "section": meta.get("section_name", ""),
                    "stud_id": meta.get("stud_id", ""),
                    "event_name": ev.get("event_name", ""),
                    "reason": "Time-in and time-out already recorded."
                })
                return

        # ═══════════════════════════════════════════════════
        # PRIORITY 2: COMPLETED → time_out (if missing)
        # ═══════════════════════════════════════════════════
        if completed:
            for ev in completed:
                ev_id = ev["event_id"]
                att_res = supabase.table("event_attendance")\
                    .select("*")\
                    .eq("event_id", ev_id)\
                    .eq("student_id", student_id)\
                    .execute()
                row = att_res.data[0] if att_res.data else None

                if row and row.get("time_in") and not row.get("time_out"):
                    supabase.table("event_attendance").update({
                        "time_out": now.isoformat(),
                        "verified_by_facial_recognition": True,
                    }).eq("attendance_id", row["attendance_id"]).execute()

                       # ── SEND TIME-OUT EMAIL ──
                    time_in_iso = row.get("time_in", "")
                    duration = 0
                    if time_in_iso:
                        try:
                            t_in = datetime.datetime.fromisoformat(time_in_iso.replace("Z", "+00:00"))
                            duration = int((now - t_in).total_seconds() // 60)
                        except Exception:
                            pass

                    thread_pool.submit(
                        _send_attendance_email,
                        student_id, ev_id, now.isoformat(), meta, ev,
                        email_type="time_out",
                        time_in_recorded=time_in_iso,
                        duration_minutes=duration
                    )
                    _push({
                        "message": f"TIME OUT {meta['name']}",
                        "name": meta["name"],
                        "type": "time_out",
                        "time": now.strftime("%I:%M %p"),
                        "grade": meta.get("grade_level", ""),
                        "section": meta.get("section_name", ""),
                        "stud_id": meta.get("stud_id", ""),
                        "event_name": ev.get("event_name", "")
                    })
                    return

            _push({
                "message": "NO TIME IN FOUND",
                "name": meta["name"],
                "type": "error",
                "reason": "You cannot time out because no valid time-in exists for any completed event."
            })
            return

        # ═══════════════════════════════════════════════════
        # PRIORITY 3: UPCOMING
        # ═══════════════════════════════════════════════════
        if upcoming:
            ev = upcoming[0]
            _push({
                "message": "EVENT NOT STARTED",
                "name": meta["name"],
                "type": "errfaor",
                "event_name": ev.get("event_name", ""),
                "reason": f"Event '{ev.get('event_name')}' hasn't started yet."
            })
            return

        _push({
            "message": "NO ACTION",
            "name": meta["name"],
            "type": "error",
            "reason": "No attendance action available."
        })

    except Exception as e:
        print(f"⚠ Auto event attendance failed: {e}")
        import traceback; traceback.print_exc()
        _push({
            "message": "RECORD ERROR",
            "name": meta["name"],
            "type": "error",
            "reason": "Failed to process attendance. Please try again."
        })

def recognition_worker():
    global latest_frame
    while True:
        time.sleep(0.05)
        with frame_lock:
            if latest_frame is None:
                continue
            frame = latest_frame.copy()
        x1, y1, x2, y2 = get_guide_bounds(frame.shape)
        roi = frame[y1:y2, x1:x2]
        if roi is None or roi.size == 0:
            with result_lock:
                recognition_result.update({"locations": [], "labels": [], "colors": []})
            continue
        if not face_db_ready.is_set():
            with result_lock:
                recognition_result.update({"locations": [], "labels": [], "colors": []})
            continue
        small = cv2.resize(roi, (0, 0), fx=0.25, fy=0.25)
        rgb   = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        locs  = face_recognition.face_locations(rgb, model="hog")
        if not locs:
            with result_lock:
                recognition_result.update({"locations": [], "labels": [], "colors": []})
            continue
        encs = face_recognition.face_encodings(rgb, locs, num_jitters=1)
        new_locs, new_labels, new_colors = [], [], []
        for (top, right, bottom, left), enc in zip(locs, encs):
            top    = top    * 4 + y1
            right  = right  * 4 + x1
            bottom = bottom * 4 + y1
            left   = left   * 4 + x1
            with face_db_lock:
                enc_np    = known_encodings_np
                meta_list = known_meta
            if enc_np is None or len(enc_np) == 0:
                new_locs.append((top, right, bottom, left))
                new_labels.append("No faces registered")
                new_colors.append((0, 0, 255))
                continue
            dists    = np.linalg.norm(enc_np - enc, axis=1)
            best_idx = int(np.argmin(dists))
            best_d   = float(dists[best_idx])
            if best_d < 0.40: 
                meta  = meta_list[best_idx]
                key   = f"{meta['role']}_{meta['id']}"
                last  = recently_seen.get(key)
                label = meta["name"]
                color = (0, 255, 0) if meta["role"] == "student" else (0, 255, 255)
                if not last or (datetime.datetime.now() - last).total_seconds() >= COOLDOWN_SECS:
                    anti_spoof = _run_anti_spoof_cached(key, frame, (top, right, bottom, left))
                    if not anti_spoof.get("allowed", True):
                        score = anti_spoof.get("score")
                        score_txt = f"{score:.2f}" if isinstance(score, (int, float)) else "n/a"
                        label = "Spoof blocked"
                        color = (0, 0, 255)
                        recently_seen[key] = datetime.datetime.now()
                        _push({
                            "message": "SPOOF DETECTED",
                            "name": meta["name"],
                            "type": "spoof",
                            "reason": f"Liveness check failed (score={score_txt}, threshold={ANTI_SPOOF_THRESHOLD:.2f}). Please face the camera directly and try again.",
                        })
                        new_locs.append((top, right, bottom, left))
                        new_labels.append(label)
                        new_colors.append(color)
                        continue
                    recently_seen[key] = datetime.datetime.now()
                    _handle_recognition(meta)
            else:
                label = "Unknown"
                color = (0, 0, 255)
            new_locs.append((top, right, bottom, left))
            new_labels.append(label)
            new_colors.append(color)
        with result_lock:
            recognition_result.update({"locations": new_locs,
                                        "labels":    new_labels,
                                        "colors":    new_colors})

threading.Thread(target=recognition_worker, daemon=True).start()

def _push(payload):
    message = json.dumps(payload)
    with attendee_clients_lock:
        clients = list(attendee_clients)
    for client_queue in clients:
        try:
            client_queue.put_nowait(message)
        except Exception:
            pass
    print(f"  → PUSH [{payload.get('message', 'GREETING')}] {payload.get('name', '')}")

# ─────────────────────────────────────────────
# Camera + frame generator
# ─────────────────────────────────────────────
def _find_camera_index(preferred_range=(1, 4), fallback_index=0, cli_index=None):
    """Try to find a working camera. Prefer external webcams (indices in preferred_range).
    Preference order:
      1) CLI `--camera-index` if provided
      2) ENV `CAMERA_INDEX` if provided
      3) auto-detect external indices in preferred_range
      4) fallback_index
    Returns an index (int) or None if nothing works.
    """
    # 1) CLI override (highest priority)
    if cli_index is not None:
        try:
            idx = int(cli_index)
            cap = cv2.VideoCapture(idx)
            ok, _ = cap.read()
            cap.release()
            if ok:
                print(f"✓ Using camera index from CLI --camera-index={idx}")
                return idx
            else:
                print(f"⚠ CLI camera index {idx} not usable, falling back to env/auto-detect")
        except Exception:
            pass

    # 2) Env override
    env_val = os.getenv("CAMERA_INDEX")
    if env_val:
        try:
            idx = int(env_val)
            cap = cv2.VideoCapture(idx)
            ok, _ = cap.read()
            cap.release()
            if ok:
                print(f"✓ Using camera index from CAMERA_INDEX={idx}")
                return idx
            else:
                print(f"⚠ CAMERA_INDEX={idx} not usable, falling back to auto-detect")
        except Exception:
            pass

    # Try preferred external indices first
    start, end = preferred_range
    for idx in range(start, end + 1):
        try:
            cap = cv2.VideoCapture(idx)
            if not cap or not cap.isOpened():
                if cap:
                    cap.release()
                continue
            ok, _ = cap.read()
            cap.release()
            if ok:
                print(f"✓ Detected camera at index {idx} (external)")
                return idx
        except Exception:
            continue

    # Fallback to internal camera (usually 0)
    try:
        cap = cv2.VideoCapture(fallback_index)
        ok, _ = cap.read()
        cap.release()
        if ok:
            print(f"✓ Using fallback camera index {fallback_index}")
            return fallback_index
    except Exception:
        pass

    print("⚠ No working camera found")
    return None


# Parse CLI args (optional) to allow forcing camera index
try:
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--camera-index', type=int, help='Force camera index (overrides CAMERA_INDEX env)')
    args, _unknown = parser.parse_known_args()
    CLI_CAMERA_INDEX = args.camera_index
except Exception:
    CLI_CAMERA_INDEX = None

# Choose camera index (CLI -> ENV -> auto-detect external webcam -> fallback 0)
_cam_index = _find_camera_index(preferred_range=(1, 4), fallback_index=0, cli_index=CLI_CAMERA_INDEX)
if _cam_index is None:
    _cam_index = 0
camera = None
camera_runtime_lock = threading.Lock()


def _open_attendance_camera():
    if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
        return cv2.VideoCapture(_cam_index, cv2.CAP_DSHOW)
    return cv2.VideoCapture(_cam_index)


def _ensure_attendance_camera_open():
    global camera
    if not _has_camera_owner():
        return False
    with camera_runtime_lock:
        if camera is not None and camera.isOpened():
            return True
        cam = _open_attendance_camera()
        try:
            cam.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            cam.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cam.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cam.set(cv2.CAP_PROP_FPS, 30)
        except Exception:
            pass
        if cam is None or not cam.isOpened():
            try:
                if cam is not None:
                    cam.release()
            except Exception:
                pass
            return False
        camera = cam
        return True


def _release_attendance_camera():
    global camera, latest_frame
    with camera_runtime_lock:
        try:
            if camera is not None and camera.isOpened():
                camera.release()
        except Exception:
            pass
        camera = None
    with frame_lock:
        latest_frame = None


def _camera_wait_frame(message):
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.rectangle(frame, (0, 0), (640, 480), (16, 20, 28), -1)
    cv2.putText(frame, "Camera is assigned to another engine", (42, 215),
                cv2.FONT_HERSHEY_SIMPLEX, 0.62, (210, 220, 235), 2)
    cv2.putText(frame, message, (42, 248),
                cv2.FONT_HERSHEY_SIMPLEX, 0.56, (120, 190, 255), 2)
    ret, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ret:
        return b""
    return (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buf.tobytes() + b'\r\n')

def generate_frames():
    global latest_frame
    while True:
        if not _has_camera_owner():
            _release_attendance_camera()
            owner = _camera_owner_now() or "none"
            yield _camera_wait_frame(f"Current owner: {owner}. Click switch to continue.")
            time.sleep(0.08)
            continue

        if not _ensure_attendance_camera_open():
            yield _camera_wait_frame("Unable to open camera. Check camera permissions/hardware.")
            time.sleep(0.12)
            continue

        ok, frame = camera.read()
        if not ok:
            _release_attendance_camera()
            yield _camera_wait_frame("Camera read failed. Retrying...")
            time.sleep(0.1)
            continue
        with frame_lock:
            latest_frame = frame.copy()
        x1, y1, x2, y2 = get_guide_bounds(frame.shape)
        guide_color = (80, 220, 160)
        cv2.rectangle(frame, (x1, y1), (x2, y2), guide_color, 2)
        corner = 28
        thick  = 3
        cv2.line(frame, (x1, y1), (x1 + corner, y1), guide_color, thick)
        cv2.line(frame, (x1, y1), (x1, y1 + corner), guide_color, thick)
        cv2.line(frame, (x2, y1), (x2 - corner, y1), guide_color, thick)
        cv2.line(frame, (x2, y1), (x2, y1 + corner), guide_color, thick)
        cv2.line(frame, (x1, y2), (x1 + corner, y2), guide_color, thick)
        cv2.line(frame, (x1, y2), (x1, y2 - corner), guide_color, thick)
        cv2.line(frame, (x2, y2), (x2 - corner, y2), guide_color, thick)
        cv2.line(frame, (x2, y2), (x2, y2 - corner), guide_color, thick)
        cv2.putText(frame, "Align face inside the frame", (x1, max(22, y1 - 10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, guide_color, 2)
        with result_lock:
            locs   = list(recognition_result["locations"])
            labels = list(recognition_result["labels"])
            colors = list(recognition_result["colors"])
        for (top, right, bottom, left), label, color in zip(locs, labels, colors):
            cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
            cv2.rectangle(frame, (left, top-30), (right, top), color, cv2.FILLED)
            cv2.putText(frame, label, (left+5, top-8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        ret, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buf.tobytes() + b'\r\n')

# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────
@app.route('/attendee_stream')
def attendee_stream():
    client_queue = queue.Queue()

    def stream():
        with attendee_clients_lock:
            attendee_clients.add(client_queue)
        try:
            while True:
                yield f"data: {client_queue.get()}\n\n"
        finally:
            with attendee_clients_lock:
                attendee_clients.discard(client_queue)

    return Response(stream(), mimetype="text/event-stream")

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/engine_status')

def engine_status():
    with engine_boot_lock:
        payload = dict(engine_boot_state)
    owner_state = _read_camera_owner_state()
    payload["face_db_ready"] = face_db_ready.is_set()
    payload["engine_online"] = True
    payload["camera_owner"] = owner_state.get("owner")
    payload["camera_owned_by_this_engine"] = owner_state.get("owner") == ENGINE_CAMERA_OWNER
    payload["anti_spoof"] = {
        "enabled": anti_spoof_state.get("enabled"),
        "available": anti_spoof_state.get("available"),
        "message": anti_spoof_state.get("message"),
        "model_dir": anti_spoof_state.get("model_dir"),
        "model_files": anti_spoof_state.get("model_files"),
        "threshold": anti_spoof_state.get("threshold"),
        "last_error": anti_spoof_state.get("last_error"),
    }
    # Expose last concise rebuild summary for UI notifications
    try:
        payload["last_rebuild_summary"] = last_rebuild_summary
    except Exception:
        payload["last_rebuild_summary"] = None
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
        _release_attendance_camera()
        with result_lock:
            recognition_result.update({"locations": [], "labels": [], "colors": []})

    return jsonify({
        "success": True,
        "owner": state.get("owner"),
        "updated_at": state.get("updated_at"),
        "engine": ENGINE_CAMERA_OWNER,
        "owns_camera": state.get("owner") == ENGINE_CAMERA_OWNER,
        "changed": bool(changed),
    })


@app.route('/trigger_rebuild', methods=['POST'])
def trigger_rebuild():
    """Trigger an incremental (or forced) rebuild of the face encodings in background.
    POST JSON: { "force": true }  -> forces a full rebuild
    """
    global face_db_loading_started
    # Simple auth: require a secret header
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force", False))
    token = (
        request.headers.get('X-REBUILD-TOKEN')
        or request.headers.get('X-REBUILD-SECRET')
        or request.args.get('token')
        or data.get('token')
        or ""
    )
    token = str(token).strip()
    expected_secret = str(REBUILD_SECRET or "").strip()
    if expected_secret:
        if not token or token != expected_secret:
            print(
                f"Unauthorized rebuild trigger from {request.remote_addr}; "
                f"token_len={len(token)} expected_len={len(expected_secret)}"
            )
            return jsonify({"success": False, "message": "Unauthorized"}), 401

    # Simple rate-limit: avoid too-frequent rebuilds
    now_ts = time.time()
    if hasattr(trigger_rebuild, '_last_ts'):
        last = getattr(trigger_rebuild, '_last_ts')
    else:
        last = 0
    if not force and (now_ts - last) < REBUILD_MIN_INTERVAL:
        return jsonify({"success": False, "message": "Rate limited"}), 429
    setattr(trigger_rebuild, '_last_ts', now_ts)

    with face_db_lock:
        already = face_db_loading_started
        if force:
            # Allow a forced rebuild even if a prior load ran; clear the flag so loader proceeds
            face_db_loading_started = False

    if already and not force:
        return jsonify({"success": False, "message": "Rebuild already in progress"}), 409

    print(f"--- Rebuild requested (force={force}) — scheduling background task ---")
    threading.Thread(target=load_all_faces, kwargs={"force_rebuild": force}, daemon=True).start()
    return jsonify({"success": True, "started": True, "force": force})


def face_auto_sync_worker():
    """Poll facial dataset path fingerprints and auto-trigger incremental rebuild on change."""
    global current_face_fingerprint
    if AUTO_REBUILD_POLL_SECONDS <= 0:
        print("⚙ Auto rebuild watcher disabled (AUTO_REBUILD_POLL_SECONDS <= 0)")
        return

    print(f"⚙ Auto rebuild watcher active (every {AUTO_REBUILD_POLL_SECONDS:.1f}s)")
    while True:
        try:
            # Only check while engine is already usable and not currently rebuilding.
            if face_db_ready.is_set() and not face_db_loading_started:
                students_rows, teachers_rows = _fetch_face_rows()
                remote_fingerprint, _ = _build_remote_face_fingerprint(students_rows, teachers_rows)

                if current_face_fingerprint is None:
                    current_face_fingerprint = remote_fingerprint
                elif remote_fingerprint != current_face_fingerprint:
                    print("--- Auto watcher detected facial data change; scheduling incremental sync ---")
                    threading.Thread(target=load_all_faces, kwargs={"force_rebuild": False}, daemon=True).start()
        except Exception as e:
            print(f"⚠ Auto rebuild watcher error: {e}")
        finally:
            time.sleep(max(3.0, AUTO_REBUILD_POLL_SECONDS))

@app.route('/shutdown', methods=['POST'])
def shutdown():
    print("--- Shutdown request received: Cleaning up ---")
    try:
        _release_attendance_camera()
        print("✓ Camera hardware released")
        thread_pool.shutdown(wait=False)
        print("✓ Terminating process...")
        os.kill(os.getpid(), signal.SIGTERM)
        return jsonify({"success": True})
    except Exception as e:
        print(f"Error during shutdown: {e}")
        return jsonify({"success": False, "error": str(e)})

threading.Thread(target=face_auto_sync_worker, daemon=True).start()

# ─────────────────────────────────────────────
# Scanner UI
# ─────────────────────────────────────────────
SCANNER_HTML = r"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>School Attendance Scanner</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0e1a;color:#fff;
     min-height:100vh;display:flex;flex-direction:column;align-items:center;
     justify-content:center;gap:14px;padding:20px}
h2{color:#22c55e;font-size:1.25rem;letter-spacing:1px;display:flex;align-items:center;gap:8px}
#pulse{width:10px;height:10px;border-radius:50%;background:#22c55e;animation:blink 1.2s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
#videoWrap{border:3px solid #166534;border-radius:14px;overflow:hidden;box-shadow:0 0 40px rgba(34,197,94,.25)}
#videoWrap img{display:block;width:640px;max-width:93vw}
#overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;justify-content:center;align-items:center}
#overlay.on{display:flex}
#card{background:#161b2e;border-radius:18px;padding:30px 28px 26px;max-width:400px;width:92%;border:2px solid #1e3a5f;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.7);animation:pop .3s ease-out}
@keyframes pop{from{opacity:0;transform:scale(.82) translateY(18px)}to{opacity:1;transform:scale(1) translateY(0)}}
#card.green{border-color:#166534}
#card.red{border-color:#7f1d1d}
.avatar{width:60px;height:60px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:26px}
.av-ok{background:#166534}.av-err{background:#7f1d1d}
#cardName{font-size:1.15rem;font-weight:700;margin-bottom:3px;color:#f1f5f9}
#cardMsg{padding:11px 14px;border-radius:9px;font-size:.9rem;line-height:1.5;margin-bottom:18px}
.ms{background:#14532d;color:#bbf7d0}.me{background:#7f1d1d;color:#fca5a5}
#countdown{font-size:.75rem;color:#64748b;margin-top:6px}
</style>
</head>
<body>
<h2><span id="pulse"></span>School Attendance — Face Scanner</h2>
<div id="videoWrap"><img src="/video_feed" alt="Live feed"></div>
<div id="overlay">
  <div id="card">
    <div id="av" class="avatar av-ok">👤</div>
    <div id="cardName"></div>
    <div id="cardMsg" class="ms"></div>
    <div id="countdown"></div>
  </div>
</div>
<script>
let timer=null,cd=null,remaining=0;
function connectSSE(){const es=new EventSource('/attendee_stream');es.onmessage=e=>show(JSON.parse(e.data));es.onerror=()=>{es.close();setTimeout(connectSSE,500);};}
connectSSE();
function show(data){
  clearInterval(cd);clearTimeout(timer);
  const card=document.getElementById('card');
  const av=document.getElementById('av');
  const msgEl=document.getElementById('cardMsg');
  const nameEl=document.getElementById('cardName');

  if(data.message && data.message.startsWith('HELLO')){
    av.className='avatar av-ok';av.textContent='👋';
    card.className='green';
    nameEl.textContent=data.name||'';
    msgEl.textContent=data.message||'';msgEl.className='ms';
    document.getElementById('overlay').classList.add('on');
    remaining=3;updateCD();
    cd=setInterval(()=>{remaining--;updateCD();if(remaining<=0)dismiss();},1000);
  } else if(data.message && (data.message.includes('SPOOF') || data.message.includes('ERROR'))){
    av.className='avatar av-err';av.textContent='❌';
    card.className='red';
    nameEl.textContent=data.name||'';
    msgEl.textContent=data.reason||data.message||'';msgEl.className='me';
    document.getElementById('overlay').classList.add('on');
    remaining=4;updateCD();
    cd=setInterval(()=>{remaining--;updateCD();if(remaining<=0)dismiss();},1000);
  }
}
function updateCD(){document.getElementById('countdown').textContent=remaining>0?`Auto-dismiss in ${remaining}s`:'';}
function dismiss(){clearInterval(cd);clearTimeout(timer);document.getElementById('overlay').classList.remove('on');}
</script>
</body>
</html>"""

@app.route('/scanner')
def scanner():
    return SCANNER_HTML

@app.route('/')
def index():
    return ('<h2 style="font-family:sans-serif;padding:20px">School Attendance ✓ &nbsp;'
            '<a href="/scanner">Open Scanner →</a></h2>')

@app.route('/ongoing_events', methods=['GET'])
def ongoing_events():
    try:
        res = supabase.table("events")\
            .select("event_id, event_name, status, event_date, time_start, time_end")\
            .eq("status", "ongoing")\
            .execute()
        return jsonify({"success": True, "events": res.data or []})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})
    

@app.route('/email_status', methods=['GET'])
def email_status():
    """Return recent email send status log for UI display."""
    limit = request.args.get('limit', 20, type=int)
    with email_status_lock:
        logs = list(email_status_log[:limit])
    return jsonify({
        "success": True,
        "count": len(logs),
        "logs": logs,
    })

@app.route('/email_status/latest', methods=['GET'])
def email_status_latest():
    """Return only the most recent email status entry."""
    with email_status_lock:
        latest = email_status_log[0] if email_status_log else None
    if latest:
        return jsonify({"success": True, "log": latest})
    return jsonify({"success": False, "message": "No email activity yet"})

if __name__ == '__main__':
    threading.Thread(target=load_all_faces, kwargs={"force_rebuild": FORCE_FACE_CACHE_REBUILD}, daemon=True).start()
    print("=" * 60)
    print("School Attendance — Supabase Edition ✓")
    print("Face DB load      : incremental background sync")
    print(f"Faces/person      : up to {max(1, MAX_IMAGES_PER_PERSON)} image(s)")
    print("Scanner UI        : http://127.0.0.1:5000/scanner")
    print("=" * 60)
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True, use_reloader=False)