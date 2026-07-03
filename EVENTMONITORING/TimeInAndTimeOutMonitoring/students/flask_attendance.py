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
import xml.etree.ElementTree as ET
import numpy as np
import cv2
import face_recognition
from concurrent.futures import ThreadPoolExecutor
try:
    import torch
except Exception:
    torch = None

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

if not SUPABASE_URL or not SUPABASE_KEY:
    print(f"CRITICAL ERROR: Could not load credentials from {env_path}")
    sys.exit(1)

# Ensure XML audit helper available early so startup logging can't fail
XML_LOG_FILE = os.path.join(script_dir, "engine_log.xml")
ENGINE_NAME = "attendance"
ENGINE_LABEL = "Attendance Engine"
ENGINE_INSTANCE_ID = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
def _log_hint(event_type, details=None):
    event_type = str(event_type)
    details = details if isinstance(details, dict) else {}
    phase = str(details.get("phase") or "").strip().lower()
    status_code = str(details.get("status_code") or "").strip()

    if event_type == "startup":
        return "The attendance engine started successfully and is ready to use."
    if event_type == "rebuild_summary":
        return "The face database was refreshed using the latest records."
    if event_type == "error" and phase == "save_face_cache":
        return "The cache could not be saved. The engine may rebuild it again later."
    if event_type == "error" and phase == "load_all_faces":
        return "The face database could not be rebuilt at startup. Check the connection and try again."
    if event_type == "error":
        return "Something went wrong. Check the message below for the reason and next step."
    if event_type == "trigger_rebuild_response":
        if status_code == "200":
            return "The attendance engine accepted the rebuild request."
        if status_code == "409":
            return "A rebuild is already running, so this request was skipped."
        if status_code == "401":
            return "The rebuild request was rejected because the secret token was not accepted."
        return "The attendance engine returned a response. Check the details below."
    return "Check the details below for more information."

def _ensure_xml_log():
    try:
        if not os.path.exists(XML_LOG_FILE):
            root = ET.Element("EngineLog", version="1")
            tree = ET.ElementTree(root)
            tmp = XML_LOG_FILE + ".tmp"
            tree.write(tmp, encoding="utf-8", xml_declaration=True)
            os.replace(tmp, XML_LOG_FILE)
    except Exception as e:
        print(f"⚠ Failed to create XML log file: {e}")

def _audit_event(event_type, details=None):
    try:
        _ensure_xml_log()
        tree = ET.parse(XML_LOG_FILE)
        root = tree.getroot()
        ev = ET.Element("Event", type=str(event_type), ts=datetime.datetime.now().isoformat())
        hint = ET.SubElement(ev, "Field", name="hint")
        hint.text = _log_hint(event_type, details)
        if isinstance(details, dict):
            for k, v in details.items():
                f = ET.SubElement(ev, "Field", name=str(k))
                f.text = str(v)
        else:
            f = ET.SubElement(ev, "Field", name="message")
            f.text = str(details)
        root.append(ev)
        tmp = XML_LOG_FILE + ".tmp"
        tree.write(tmp, encoding="utf-8", xml_declaration=True)
        os.replace(tmp, XML_LOG_FILE)
    except Exception as e:
        print(f"⚠ Failed to write XML audit event: {e}")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
print("✓ Supabase client ready (Loaded from .env)")
_audit_event("startup", {"message": "Supabase client ready (Loaded from .env)"})

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
        _audit_event("startup", {
            "phase": "anti_spoof",
            "status": "ready",
            "device": anti_spoof_runtime["device"],
            "models": ",".join(os.path.basename(v) for v in model_paths),
        })
    except Exception as exc:
        anti_spoof_state.update({
            "available": False,
            "message": "model_load_failed",
            "last_error": str(exc),
        })
        print(f"⚠ Anti-spoofing model load failed: {exc}")
        _audit_event("error", {"phase": "anti_spoof_init", "error": str(exc)})


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
        _audit_event("error", {"phase": "anti_spoof_infer", "error": str(exc)})
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


# ----------------------
# XML Audit Logger
# ----------------------
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
            "group_key": ENGINE_INSTANCE_ID,
            "group_label": ENGINE_LABEL if event_type != "startup" else f"{ENGINE_LABEL} Started",
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
        # Avoid raising from logging failures; print to plain text log instead
        print(f"⚠ Failed to write XML audit event: {e}")

# Last rebuild summary visible via /engine_status
last_rebuild_summary = None
current_face_fingerprint = None

student_action_inflight = {}
student_action_lock = threading.Lock()
STUDENT_ACTION_TTL_SECS = 10

PROFESSOR_START_WINDOW = 45
STUDENT_GRACE_MINUTES  = 15

thread_pool = ThreadPoolExecutor(max_workers=3)

MACHINE_LAB_CONFIG_FILE = os.path.join(script_dir, "machine_lab_config.json")
_machine_lab_config_cache = {"mtime": None, "data": None}


def _format_lab_label(info):
    if not info:
        return "Unassigned"
    code = str(info.get("lab_code") or "").strip()
    name = str(info.get("lab_name") or "").strip()
    if code and name:
        return f"{code} - {name}"
    if code:
        return code
    if name:
        return name
    lab_id = str(info.get("lab_id") or "").strip()
    return f"Lab {lab_id}" if lab_id else "Unassigned"


def _load_machine_lab_config(force=False):
    default_config = {
        "configured": False,
        "lab_id": None,
        "lab_code": None,
        "lab_name": None,
        "building": None,
        "saved_at": None,
        "machine_name": os.getenv("COMPUTERNAME") or os.getenv("HOSTNAME") or os.uname().nodename if hasattr(os, "uname") else None,
    }

    if not os.path.exists(MACHINE_LAB_CONFIG_FILE):
        return default_config

    try:
        mtime = os.path.getmtime(MACHINE_LAB_CONFIG_FILE)
        cached = _machine_lab_config_cache.get("data")
        if not force and _machine_lab_config_cache.get("mtime") == mtime and cached is not None:
            return dict(cached)

        with open(MACHINE_LAB_CONFIG_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)

        if not isinstance(data, dict):
            return default_config

        data["configured"] = bool(str(data.get("lab_id") or "").strip() or str(data.get("lab_code") or "").strip())
        _machine_lab_config_cache["mtime"] = mtime
        _machine_lab_config_cache["data"] = dict(data)
        return dict(data)
    except Exception as exc:
        print(f"⚠ Failed to read machine lab config: {exc}")
        return default_config


def _load_lab_assignment_for_schedule(schedule_id):
    if not schedule_id:
        return None

    result = supabase.table("lab_schedules")\
        .select("schedule_id, lab_id, subjects(subject_code, subject_name), laboratory_rooms(lab_id, lab_code, lab_name)")\
        .eq("schedule_id", schedule_id)\
        .execute()
    row = result.data[0] if result.data else None
    if not row:
        return None

    room = row.get("laboratory_rooms") or {}
    return {
        "schedule_id": row.get("schedule_id"),
        "lab_id": row.get("lab_id"),
        "lab_code": room.get("lab_code"),
        "lab_name": room.get("lab_name"),
        "subject_code": (row.get("subjects") or {}).get("subject_code"),
    }


def _terminal_allows_schedule(schedule_id):
    machine_lab = _load_machine_lab_config()
    if not machine_lab.get("configured"):
        return False, "This terminal is not assigned to a laboratory yet. Please configure the machine on the Take Attendance page.", machine_lab, None

    schedule_lab = _load_lab_assignment_for_schedule(schedule_id)
    if not schedule_lab:
        return False, "Unable to determine the scheduled laboratory for this session.", machine_lab, None

    machine_lab_id = str(machine_lab.get("lab_id") or "").strip()
    machine_lab_code = str(machine_lab.get("lab_code") or "").strip().lower()
    schedule_lab_id = str(schedule_lab.get("lab_id") or "").strip()
    schedule_lab_code = str(schedule_lab.get("lab_code") or "").strip().lower()

    if machine_lab_id and schedule_lab_id and machine_lab_id == schedule_lab_id:
        return True, None, machine_lab, schedule_lab

    if machine_lab_code and schedule_lab_code and machine_lab_code == schedule_lab_code:
        return True, None, machine_lab, schedule_lab

    schedule_label = _format_lab_label(schedule_lab)
    machine_label = _format_lab_label(machine_lab)
    return False, f"You are scheduled in Laboratory {schedule_label}, please use the correct terminal. This terminal is locked to Laboratory {machine_label}.", machine_lab, schedule_lab

# ─────────────────────────────────────────────
# Timezone-safe datetime parser
# ─────────────────────────────────────────────
def parse_dt(value) -> datetime.datetime:
    if value is None:
        return None
    s = str(value).replace('Z', '+00:00')
    try:
        dt = datetime.datetime.fromisoformat(s)
    except ValueError:
        dt = datetime.datetime.fromisoformat(s[:19])
        return dt
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt

def get_now():
    now_store = datetime.datetime.now(datetime.timezone.utc)
    now_local = datetime.datetime.now()
    return now_store, now_local

def _mark_student_action_inflight(student_id, session_id, action, ttl=STUDENT_ACTION_TTL_SECS):
    if not student_id or not session_id or action not in ("IN", "OUT"):
        return True
    now_ts = time.time()
    key = (str(student_id), str(session_id), action)
    with student_action_lock:
        expired = [k for k, expires_at in student_action_inflight.items() if expires_at <= now_ts]
        for k in expired:
            student_action_inflight.pop(k, None)
        expires_at = student_action_inflight.get(key, 0)
        if expires_at > now_ts:
            return False
        student_action_inflight[key] = now_ts + ttl
        return True

def _clear_student_action_inflight(student_id, session_id, action=None):
    if not student_id or not session_id:
        return
    sid = str(student_id)
    sess = str(session_id)
    with student_action_lock:
        if action in ("IN", "OUT"):
            student_action_inflight.pop((sid, sess, action), None)
            return
        student_action_inflight.pop((sid, sess, "IN"), None)
        student_action_inflight.pop((sid, sess, "OUT"), None)

# ─────────────────────────────────────────────
# Face database globals
# ─────────────────────────────────────────────
known_encodings    = []
known_meta         = []
known_encodings_np = None

def _hash_payload(obj) -> str:
    payload = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def _to_json_safe(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)

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

def _build_remote_face_manifest(students_rows, professors_rows):
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
    for row in professors_rows:
        folder = row.get("facial_dataset_path")
        if not folder:
            continue
        folder_images = _list_face_images_for_folder(folder)
        manifest.append({
            "role": "professor",
            "id": _to_json_safe(row.get("professor_id")),
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

def _build_remote_face_fingerprint(students_rows, professors_rows):
    """Fingerprint only the facial dataset scope so unrelated DB edits do not trigger sync."""
    manifest = _build_remote_face_manifest(students_rows, professors_rows)
    return _hash_payload(manifest), manifest

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
        _audit_event("error", {"phase": "save_face_cache", "error": str(e)})

def _activate_face_db(encodings, meta):
    global known_encodings, known_meta, known_encodings_np
    with face_db_lock:
        known_meta      = list(meta)
        known_encodings = [np.asarray(v, dtype=np.float32) for v in encodings] if len(encodings) else []
        known_encodings_np = np.asarray(encodings, dtype=np.float32) if len(encodings) else None

def _fetch_face_rows():
    students_result = supabase.table("students")\
        .select("student_id, id_number, first_name, middle_name, last_name, facial_dataset_path")\
        .not_.is_("facial_dataset_path", "null")\
        .neq("facial_dataset_path", "")\
        .execute()
    professors_result = supabase.table("professors")\
        .select("professor_id, employee_id, first_name, middle_name, last_name, facial_dataset_path")\
        .not_.is_("facial_dataset_path", "null")\
        .neq("facial_dataset_path", "")\
        .eq("status", "active")\
        .execute()
    return students_result.data or [], professors_result.data or []

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
        students_rows, professors_rows = _fetch_face_rows()

        # Build the facial-path fingerprint (used to detect only face dataset path changes)
        try:
            remote_fingerprint, _ = _build_remote_face_fingerprint(students_rows, professors_rows)
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
                    _audit_event("rebuild_summary", last_rebuild_summary)
                except Exception:
                    pass
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
                _audit_event("rebuild_summary", last_rebuild_summary)
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
        # Key format:  "student_<student_id>"  or  "professor_<professor_id>"
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

        for row in professors_rows:
            folder = row.get("facial_dataset_path")
            if not folder:
                continue
            images     = _list_face_images_for_folder(folder)
            person_key = f"professor_{row['professor_id']}"
            remote_keys.add(person_key)
            new_fp     = _person_fingerprint("professor", row["professor_id"], folder, images)
            all_remote_rows.append({
                "key":    person_key,
                "role":   "professor",
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
                meta = {
                    "role":      "student",
                    "id":        row["student_id"],
                    "id_number": row["id_number"],
                    "name":      f"{row['first_name']} {mid} {row['last_name']}".strip(),
                }
            else:
                mid  = row.get("middle_name") or ""
                meta = {
                    "role":        "professor",
                    "id":          row["professor_id"],
                    "employee_id": row["employee_id"],
                    "name":        f"Prof. {row['first_name']} {mid} {row['last_name']}".strip(),
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
            _audit_event("rebuild_summary", last_rebuild_summary)
        except Exception:
            pass

    except Exception as e:
        with engine_boot_lock:
            d = dict(engine_boot_state.get("durations_ms") or {})
            d["total_startup"] = round((time.perf_counter() - overall_t0) * 1000, 2)
        _set_engine_boot_state(status="ready", face_db_phase="error", error=str(e), durations_ms=d)
        print(f"⚠ Failed to build face database at startup: {e}")
        _audit_event("error", {"phase": "load_all_faces", "error": str(e)})
        import traceback; traceback.print_exc()
    finally:
        with face_db_lock:
            loaded = len(known_meta)
            face_db_loading_started = False
        _set_engine_boot_state(encodings_loaded=loaded, cache_exists=os.path.exists(FACE_CACHE_FILE))
        face_db_ready.set()
        print("=" * 60)

# ─────────────────────────────────────────────
# Session Cache
# ─────────────────────────────────────────────
schedule_cache    = {}
session_cache     = {}
attendance_cache  = {}
acknowledged_done = set()
cache_lock        = threading.Lock()
last_cache_refresh = 0
CACHE_TTL         = 60

def refresh_session_cache():
    global last_cache_refresh
    today = datetime.date.today()
    try:
        result = supabase.table("lab_sessions")\
            .select("session_id, schedule_id, status")\
            .eq("session_date", str(today))\
            .execute()
        with cache_lock:
            session_cache.clear()
            for row in (result.data or []):
                session_cache[row["schedule_id"]] = (row["session_id"], row["status"])
        last_cache_refresh = time.time()
        print(f"✓ Session cache refreshed: {len(session_cache)} sessions")
    except Exception as e:
        print(f"⚠ Session cache refresh failed: {e}")

def get_session_cached(schedule_id):
    if time.time() - last_cache_refresh > CACHE_TTL:
        threading.Thread(target=refresh_session_cache, daemon=True).start()
    with cache_lock:
        return session_cache.get(schedule_id, (None, "not_created"))

def update_session_cache(schedule_id, session_id, status):
    with cache_lock:
        session_cache[schedule_id] = (session_id, status)

def get_attendance_cached(session_id, student_id):
    key = (session_id, student_id)
    with cache_lock:
        if key in attendance_cache:
            return attendance_cache[key]
    result = supabase.table("lab_attendance")\
        .select("attendance_id, time_in, time_out")\
        .eq("session_id", session_id)\
        .eq("student_id", student_id)\
        .execute()
    rec = result.data[0] if result.data else None
    with cache_lock:
        attendance_cache[key] = rec
    return rec

def invalidate_attendance_cache(session_id, student_id):
    with cache_lock:
        attendance_cache.pop((session_id, student_id), None)

def td_to_secs(td):
    if isinstance(td, datetime.timedelta):
        return int(td.total_seconds())
    if isinstance(td, str):
        td = td.split('.')[0]
        parts = td.split(':')
        return int(parts[0])*3600 + int(parts[1])*60 + int(parts[2]) if len(parts) == 3 else 0
    return 0

# ─────────────────────────────────────────────
# Supabase DB helpers
# ─────────────────────────────────────────────
def find_professor_schedule(professor_id, today):
    day_name = today.strftime("%A")
    result = supabase.table("lab_schedules")\
        .select("schedule_id, section, start_time, end_time, subjects(subject_code, subject_name), laboratory_rooms(lab_code, lab_name)")\
        .eq("professor_id", professor_id)\
        .eq("day_of_week", day_name)\
        .eq("status", "active")\
        .order("start_time")\
        .execute()
    schedules = result.data or []
    output    = []
    for sch in schedules:
        session_id, session_status = get_session_cached(sch["schedule_id"])
        output.append({
            "schedule_id":    sch["schedule_id"],
            "section":        sch["section"],
            "subject_code":   sch["subjects"]["subject_code"] if sch.get("subjects") else "N/A",
            "lab_code":       sch["laboratory_rooms"]["lab_code"] if sch.get("laboratory_rooms") else "N/A",
            "start_time":     sch["start_time"] or "00:00:00",
            "end_time":       sch["end_time"]   or "00:00:00",
            "session_id":     session_id,
            "session_status": session_status,
        })
    return output

def find_student_schedule(student_id, today):
    day_name = today.strftime("%A")
    result = supabase.table("schedule_enrollments")\
        .select("schedule_id, lab_schedules!inner(schedule_id, start_time, end_time, day_of_week, status)")\
        .eq("student_id", student_id)\
        .eq("status", "enrolled")\
        .execute()
    rows = result.data or []
    matching = [
        r for r in rows
        if r.get("lab_schedules") and
           r["lab_schedules"].get("day_of_week") == day_name and
           r["lab_schedules"].get("status") == "active"
    ]
    if not matching:
        return ("NOT_ENROLLED",)
    matching.sort(key=lambda x: td_to_secs(x["lab_schedules"]["start_time"] or "00:00:00"))
    best, priority = None, 99
    for row in matching:
        sch = row["lab_schedules"]
        schedule_id = sch["schedule_id"]
        session_id, session_status = get_session_cached(schedule_id)
        is_student_done = False
        if session_id:
            rec = get_attendance_cached(session_id, student_id)
            if rec and rec.get("time_in") and rec.get("time_out"):
                is_student_done = True
        if session_status == "cancelled":
            continue
        if is_student_done or session_status == "completed":
            if session_id and (student_id, session_id) not in acknowledged_done:
                acknowledged_done.add((student_id, session_id))
                return (schedule_id, sch["start_time"], sch["end_time"], session_id, session_status)
            else:
                continue
        rank = {'ongoing': 1, 'dismissing': 1, 'scheduled': 2, 'not_created': 3}.get(session_status, 5)
        if rank < priority:
            priority = rank
            best = (schedule_id, sch["start_time"], sch["end_time"], session_id, session_status)
        if priority == 1:
            break
    if best is None:
        return ("ALL_DONE",)
    return best

def get_or_create_session(schedule_id, today):
    session_id, status = get_session_cached(schedule_id)
    if session_id:
        return session_id, status
    now_store, _ = get_now()
    insert_result = supabase.table("lab_sessions").insert({
        "schedule_id":  schedule_id,
        "session_date": str(today),
        "status":       "scheduled",
        "created_at":   now_store.isoformat()
    }).execute()
    new_id = insert_result.data[0]["session_id"]
    update_session_cache(schedule_id, new_id, "scheduled")
    return new_id, "scheduled"

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
                            "role":      meta["role"],
                            "name":      meta["name"],
                            "action":    "SPOOF_DETECTED",
                            "error":     f"Liveness check failed (score={score_txt}, threshold={ANTI_SPOOF_THRESHOLD:.2f}). Please face the camera directly and try again.",
                            "liveness_score": score,
                            "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        })
                        new_locs.append((top, right, bottom, left))
                        new_labels.append(label)
                        new_colors.append(color)
                        continue
                    recently_seen[key] = datetime.datetime.now()
                    _push({
                        "role":      meta["role"],
                        "name":      meta["name"],
                        "action":    "LOADING",
                        "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    })
                    thread_pool.submit(handle_recognized, meta,
                                       datetime.date.today(), datetime.datetime.now())
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

def handle_recognized(meta, today, now):
    try:
        if meta["role"] == "professor":
            _handle_professor(meta, today, now)
        else:
            _handle_student(meta, today, now)
    except Exception as e:
        print(f"[ERROR] handle_recognized: {e}")
        import traceback; traceback.print_exc()

def _push(payload):
    message = json.dumps(payload)
    with attendee_clients_lock:
        clients = list(attendee_clients)
    for client_queue in clients:
        try:
            client_queue.put_nowait(message)
        except Exception:
            pass
    print(f"  → PUSH [{payload['action']}] {payload['name']}")

# ─────────────────────────────────────────────
# Professor flow
# ─────────────────────────────────────────────
def _handle_professor(meta, today, now):
    pid, emp_id, name = meta["id"], meta["employee_id"], meta["name"]
    print(f"\n[PROF] {name} @ {now:%H:%M:%S} | today={today.strftime('%A')}")
    all_schedules = find_professor_schedule(pid, today)
    if not all_schedules:
        print(f"  → No active schedule on {today.strftime('%A')}")
        return _push({"role":"professor","professor_id":pid,"employee_id":emp_id,
                       "name":name,"action":"ALL_DONE","session_id":None,
                       "error":"You have no class scheduled today.",
                       "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
    closest_future_schedule = None
    closest_future_time     = None
    for sched in all_schedules:
        schedule_id    = sched["schedule_id"]
        session_id     = sched["session_id"]
        session_status = sched["session_status"]
        s = datetime.datetime.combine(today, datetime.time()) + datetime.timedelta(seconds=td_to_secs(sched["start_time"]))
        e = datetime.datetime.combine(today, datetime.time()) + datetime.timedelta(seconds=td_to_secs(sched["end_time"]))
        w = s - datetime.timedelta(minutes=30)
        void_cutoff = s + datetime.timedelta(minutes=PROFESSOR_START_WINDOW)
        print(f"  → Checking {sched['subject_code']} {s:%I:%M %p}–{e:%I:%M %p} | status={session_status}")
        prof_track_key = (pid, schedule_id)
        if session_status in ("completed", "cancelled"):
            if prof_track_key not in acknowledged_done:
                acknowledged_done.add(prof_track_key)
                action_type = "SESSION_ENDED" if session_status == "completed" else "SESSION_CANCELLED"
                msg = "Session successfully completed!" if session_status == "completed" else "This session was voided/cancelled."
                print(f"     → Acknowledging {session_status} once")
                return _push({"role":"professor","professor_id":pid,"employee_id":emp_id,
                               "name":name,"action":action_type,"session_id":session_id,"schedule":sched,
                               "error":msg,"timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
            else:
                print(f"     → Already acknowledged {session_status}, jumping to next...")
                continue
        if now < w:
            mins = int((w - now).total_seconds() / 60)
            print(f"     → Too early ({mins} min until window opens)")
            closest_future_schedule = sched
            closest_future_time     = s
            break
        if session_status in ("scheduled", "not_created", None) and now > void_cutoff:
            print(f"     → AUTO-VOID (past {PROFESSOR_START_WINDOW}-min window)")
            if not session_id:
                now_store, _ = get_now()
                insert_result = supabase.table("lab_sessions").insert({
                    "schedule_id":  schedule_id,
                    "session_date": str(today),
                    "status":       "cancelled",
                    "notes":        "System Auto-Void: 45-minute grace period elapsed",
                    "created_at":   now_store.isoformat()
                }).execute()
                session_id = insert_result.data[0]["session_id"]
            else:
                now_store, _ = get_now()
                supabase.table("lab_sessions").update({
                    "status":     "cancelled",
                    "notes":      "System Auto-Void: 45-minute grace period elapsed",
                    "updated_at": now_store.isoformat()
                }).eq("session_id", session_id).execute()
            update_session_cache(schedule_id, session_id, "cancelled")
            acknowledged_done.add(prof_track_key)
            return _push({"role":"professor","professor_id":pid,"employee_id":emp_id,
                           "name":name,"action":"SESSION_CANCELLED","session_id":session_id,"schedule":sched,
                           "error":"Class auto-voided: 45-minute start window elapsed.",
                           "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
        if now > e and session_status in ("scheduled", "not_created", None):
            print(f"     → Class completely missed. Skipping...")
            continue
        if not session_id:
            now_store, _ = get_now()
            insert_result = supabase.table("lab_sessions").insert({
                "schedule_id":  schedule_id,
                "session_date": str(today),
                "status":       "scheduled",
                "created_at":   now_store.isoformat()
            }).execute()
            session_id     = insert_result.data[0]["session_id"]
            session_status = "scheduled"
            update_session_cache(schedule_id, session_id, session_status)
        if session_status in ("scheduled", "not_created"):
            action = "START"
        elif session_status == "ongoing":
            dismiss_result = supabase.table("lab_sessions")\
                .select("actual_dismiss_time")\
                .eq("session_id", session_id)\
                .execute()
            dismiss_row = dismiss_result.data[0] if dismiss_result.data else None
            if dismiss_row and dismiss_row.get("actual_dismiss_time") is not None:
                action = "END"
                print(f"     → STAY IN detected (dismissed at {dismiss_row['actual_dismiss_time']})")
            else:
                action = "DISMISS"
        elif session_status == "dismissing":
            action = "END"
        else:
            action = "START"
        print(f"     ✓ Action={action} session_id={session_id}")
        
        # ──── CHECK LAB VALIDATION ────
        allowed, error_msg, machine_lab, schedule_lab = _terminal_allows_schedule(schedule_id)
        payload = {"role":"professor","professor_id":pid,"employee_id":emp_id,
                   "name":name,"action":action,"session_id":session_id,"schedule":sched,
                   "machine_lab":machine_lab,"schedule_lab":schedule_lab,
                   "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")}
        if not allowed:
            # Don't block — inform the UI with a warning so professor can still start the session.
            print(f"     ⚠ Lab mismatch (non-blocking): {error_msg}")
            payload["warning"] = error_msg

        return _push(payload)
    print(f"  → No valid schedule in current window")
    if closest_future_schedule:
        window_open = closest_future_time - datetime.timedelta(minutes=30)
        mins_until  = int((window_open - now).total_seconds() / 60)
        return _push({"role":"professor","professor_id":pid,"employee_id":emp_id,
                       "name":name,"action":"TOO_EARLY","session_id":None,
                       "schedule":closest_future_schedule,
                       "error":f"Next class {closest_future_schedule['subject_code']} starts at {closest_future_time:%I:%M %p}. Window opens at {window_open:%I:%M %p} ({mins_until} min from now).",
                       "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
    return _push({"role":"professor","professor_id":pid,"employee_id":emp_id,
                   "name":name,"action":"ALL_DONE","session_id":None,
                   "error":"You have no more classes for today.",
                   "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})

# ─────────────────────────────────────────────
# Student flow
# ─────────────────────────────────────────────
def _handle_student(meta, today, now):
    sid, id_num, name = meta["id"], meta["id_number"], meta["name"]
    print(f"\n[STUDENT] {name} @ {now:%H:%M:%S} | today={today.strftime('%A')}")
    row = find_student_schedule(sid, today)
    if row and row[0] == "NOT_ENROLLED":
        return _push({"role":"student","student_id":sid,"id_number":id_num,
                       "name":name,"action":"NOT_ENROLLED","session_id":None,
                       "error":"You are not enrolled in any subject with a schedule today.",
                       "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
    if row and row[0] == "ALL_DONE":
        return _push({"role":"student","student_id":sid,"id_number":id_num,
                       "name":name,"action":"ALL_DONE","session_id":None,
                       "error":"You have no more classes for today.",
                       "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
    if not row:
        return _push({"role":"student", "action":"NOT_ENROLLED", "error":"No schedule found."})
    schedule_id, start_td, end_td, session_id, status = row
    s = datetime.datetime.combine(today, datetime.time()) + datetime.timedelta(seconds=td_to_secs(start_td))
    e = datetime.datetime.combine(today, datetime.time()) + datetime.timedelta(seconds=td_to_secs(end_td))
    schedule_info = None
    try:
        schedule_result = supabase.table("lab_schedules")\
            .select("schedule_id, section, day_of_week, subjects(subject_code, subject_name), laboratory_rooms(lab_code, lab_name)")\
            .eq("schedule_id", schedule_id)\
            .single()\
            .execute()
        schedule_row = schedule_result.data or {}
        room_row = schedule_row.get("laboratory_rooms") or {}
        subject_row = schedule_row.get("subjects") or {}
        schedule_info = {
            "schedule_id": schedule_id,
            "subject_code": subject_row.get("subject_code"),
            "section": schedule_row.get("section"),
            "lab_code": room_row.get("lab_code"),
            "lab_name": room_row.get("lab_name"),
            "day_of_week": today.strftime("%A"),
            "start_time": s.strftime("%I:%M %p"),
            "end_time": e.strftime("%I:%M %p"),
        }
    except Exception:
        schedule_info = {
            "schedule_id": schedule_id,
            "day_of_week": today.strftime("%A"),
            "start_time": s.strftime("%I:%M %p"),
            "end_time": e.strftime("%I:%M %p"),
        }
    schedule_payload = {
        **schedule_info,
        "start_time": s.strftime("%I:%M %p"),
        "end_time": e.strftime("%I:%M %p"),
    }
    if status in ("not_created", "scheduled", None) or session_id is None:
        return _push({"role":"student","student_id":sid,"id_number":id_num,
                   "name":name,"action":"SESSION_NOT_STARTED","session_id":None,
                   "schedule": schedule_payload,
                   "error":f"Professor has not started the session yet. Class starts at {s:%I:%M %p}.",
                   "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
    sess_result = supabase.table("lab_sessions")\
        .select("actual_start_time")\
        .eq("session_id", session_id)\
        .execute()
    sess_row = sess_result.data[0] if sess_result.data else None
    is_late      = False
    late_minutes = 0
    if sess_row and sess_row.get("actual_start_time") is not None:
        actual_start_secs = td_to_secs(sess_row["actual_start_time"])
        session_start_dt  = datetime.datetime.combine(today, datetime.time()) + datetime.timedelta(seconds=actual_start_secs)
        grace_cutoff      = session_start_dt + datetime.timedelta(minutes=STUDENT_GRACE_MINUTES)
        if now > grace_cutoff:
            is_late      = True
            late_minutes = int((now - session_start_dt).total_seconds() / 60)
    rec = get_attendance_cached(session_id, sid)
    if rec and rec.get("time_in") and rec.get("time_out"):
        action = "COMPLETED"
    elif status == "completed":
        return _push({"role":"student","student_id":sid,"id_number":id_num,
                       "name":name,"action":"SESSION_ENDED","session_id":session_id,
                       "schedule": schedule_payload,
                       "error":"This session has already ended.",
                       "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
    elif rec is None:
        action = "IN"
    elif rec["time_in"] and not rec["time_out"]:
        if status == "ongoing":
            return _push({"role":"student","student_id":sid,"id_number":id_num,
                           "name":name,"action":"CANNOT_TIME_OUT","session_id":session_id,
                           "schedule": schedule_payload,
                           "error":"Professor has not allowed dismissal yet.",
                           "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})
        action = "OUT"
    if action in ("IN", "OUT") and not _mark_student_action_inflight(sid, session_id, action):
        print(f"  → Debounced duplicate student action {action} for student_id={sid} session_id={session_id}")
        return
    _push({"role":"student","student_id":sid,"id_number":id_num,
           "name":name,"action":action,"session_id":session_id,
            "schedule": schedule_payload,
           "is_late":is_late,"late_minutes":late_minutes,
           "timestamp":now.strftime("%Y-%m-%d %H:%M:%S")})

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
camera = cv2.VideoCapture(_cam_index)
camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)
camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
camera.set(cv2.CAP_PROP_FPS, 30)

def generate_frames():
    global latest_frame
    while True:
        ok, frame = camera.read()
        if not ok:
            break
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
@app.route('/confirm_attendance', methods=['POST'])
def confirm_attendance():
    data       = request.get_json()
    student_id = data.get("student_id")
    session_id = data.get("session_id")
    action     = data.get("action")
    now_store, now_local = get_now()
    no_db = {"NO_SCHEDULE","NOT_ENROLLED","SESSION_NOT_STARTED","SESSION_ENDED",
             "CANNOT_TIME_OUT","SESSION_CANCELLED","COMPLETED"}
    if action in no_db:
        return jsonify({"success": True, "message": data.get("error", action)})
    if not session_id:
        return jsonify({"success": False, "message": "Missing session_id"}), 400

    session_result = supabase.table("lab_sessions")\
        .select("schedule_id, status")\
        .eq("session_id", session_id)\
        .execute()
    session_row = session_result.data[0] if session_result.data else None
    if not session_row:
        return jsonify({"success": False, "message": "Session not found."}), 404

    # Only enforce terminal lock if the session has not yet been started.
    sess_status = (session_row.get("status") or "").lower()
    if sess_status in ("scheduled", "not_created", ""):
        allowed, message, _, _ = _terminal_allows_schedule(session_row.get("schedule_id"))
        if not allowed:
            return jsonify({"success": False, "message": message}), 409

    inflight_action = action if action in ("IN", "OUT") else None
    if inflight_action:
        _mark_student_action_inflight(student_id, session_id, inflight_action, ttl=STUDENT_ACTION_TTL_SECS + 2)
    try:
        if action == "OUT":
            sess_result = supabase.table("lab_sessions")\
                .select("status").eq("session_id", session_id).execute()
            if sess_result.data and sess_result.data[0]["status"] == "ongoing":
                return jsonify({"success": False,
                                "message": "❌ Time-out blocked — professor has not enabled dismissal yet."})
        att_result = supabase.table("lab_attendance")\
            .select("attendance_id, time_in, time_out")\
            .eq("session_id", session_id)\
            .eq("student_id", student_id)\
            .execute()
        rec = att_result.data[0] if att_result.data else None
        if rec is None:
            is_late      = data.get("is_late", False)
            late_minutes = int(data.get("late_minutes", 0))
            time_status  = "late" if is_late else "on-time"
            try:
                supabase.table("lab_attendance").insert({
                    "session_id":                     session_id,
                    "student_id":                     student_id,
                    "time_in":                        now_store.isoformat(),
                    "time_in_status":                 time_status,
                    "late_minutes":                   late_minutes,
                    "verified_by_facial_recognition": True,
                    "created_at":                     now_store.isoformat()
                }).execute()
            except Exception as insert_err:
                err_txt = str(insert_err).lower()
                if "duplicate" in err_txt or "unique" in err_txt:
                    invalidate_attendance_cache(session_id, student_id)
                    if student_id:
                        # Extended cooldown (8s) to prevent duplicate modals
                        recently_seen[f"student_{student_id}"] = datetime.datetime.now() + datetime.timedelta(seconds=3)
                    return jsonify({"success": True, "message": "Time IN already recorded ✔"})
                raise
            invalidate_attendance_cache(session_id, student_id)
            if student_id:
                # Extended cooldown (8s) to prevent duplicate modals
                recently_seen[f"student_{student_id}"] = datetime.datetime.now() + datetime.timedelta(seconds=3)
            # attendance IN event: auditing omitted per configuration (engine-level logs only)
            msg = f"Time IN recorded ✅ — {'⚠ LATE by '+str(late_minutes)+' min' if is_late else 'On Time'}"
            return jsonify({"success": True, "message": msg})
        if rec["time_in"] and not rec["time_out"]:
            time_in_dt = parse_dt(rec["time_in"])
            duration   = int((now_local - time_in_dt).total_seconds() / 60)
            supabase.table("lab_attendance").update({
                "time_out":         now_store.isoformat(),
                "duration_minutes": duration,
                "updated_at":       now_store.isoformat()
            }).eq("attendance_id", rec["attendance_id"]).execute()
            invalidate_attendance_cache(session_id, student_id)
            if student_id:
                # Extended cooldown (8s) to prevent duplicate modals
                recently_seen[f"student_{student_id}"] = datetime.datetime.now() + datetime.timedelta(seconds=3)
            # attendance OUT event: auditing omitted per configuration (engine-level logs only)
            return jsonify({"success": True, "message": "Time OUT recorded ✅"})
        return jsonify({"success": True, "message": "Attendance already complete ✔"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
    finally:
        if inflight_action:
            _clear_student_action_inflight(student_id, session_id, inflight_action)

@app.route('/confirm_session', methods=['POST'])
def confirm_session():
    data         = request.get_json()
    session_id   = data.get("session_id")
    action       = data.get("action")
    schedule     = data.get("schedule", {})
    schedule_id  = schedule.get("schedule_id") if schedule else None
    if not schedule_id:
        schedule_id = data.get("schedule_id")
    professor_id = data.get("professor_id")
    now_store, now_local = get_now()
    no_db = {"NO_SCHEDULE","TOO_EARLY","SCHEDULE_ENDED","SESSION_VOIDED",
             "SESSION_ALREADY_ENDED","NO_VALID_SCHEDULE"}
    if action in no_db:
        return jsonify({"success": True, "message": data.get("error", action)})
    if not session_id:
        return jsonify({"success": False, "message": "Missing session_id"}), 400

    if not schedule_id:
        session_result = supabase.table("lab_sessions")\
            .select("schedule_id")\
            .eq("session_id", session_id)\
            .execute()
        session_row = session_result.data[0] if session_result.data else None
        schedule_id = session_row.get("schedule_id") if session_row else None

    if not schedule_id:
        return jsonify({"success": False, "message": "Session not found."}), 404

    machine_lab = None
    schedule_lab = None
    mismatch_msg = None
    if schedule_id:
        allowed, message, machine_lab, schedule_lab = _terminal_allows_schedule(schedule_id)
        if not allowed:
            # Do not block professor — allow starting from any terminal.
            # Record the mismatch message so the caller/UI may display a warning.
            mismatch_msg = message

    try:
        if action == "START":
            supabase.table("lab_sessions").update({
                "status":            "ongoing",
                "actual_start_time": now_local.time().isoformat(),
                "updated_at":        now_store.isoformat()
            }).eq("session_id", session_id).execute()
            # If this session was started on a different machine lab, try to persist that info.
            try:
                if machine_lab and machine_lab.get("lab_id"):
                    supabase.table("lab_sessions").update({"lab_id": machine_lab.get("lab_id"), "updated_at": now_store.isoformat()}).eq("session_id", session_id).execute()
            except Exception:
                # Ignore if DB schema doesn't include lab_id or update fails
                pass
            # Append a short note indicating where the session was started and what was scheduled
            try:
                existing = supabase.table("lab_sessions").select("notes").eq("session_id", session_id).maybe_single().execute()
                notes = None
                if existing and existing.data:
                    notes = (existing.data.get("notes") or "").strip()
                schedule_label = _format_lab_label(schedule_lab) if schedule_lab else None
                machine_label = _format_lab_label(machine_lab) if machine_lab else None
                note_entry = None
                if machine_label and schedule_label and machine_label != schedule_label:
                    note_entry = f"Started in {machine_label} (scheduled {schedule_label})"
                elif machine_label:
                    note_entry = f"Started in {machine_label}"
                if note_entry:
                    new_notes = (notes + "\n" + note_entry).strip() if notes else note_entry
                    supabase.table("lab_sessions").update({"notes": new_notes, "updated_at": now_store.isoformat()}).eq("session_id", session_id).execute()
            except Exception:
                pass
            if schedule_id:
                update_session_cache(schedule_id, session_id, "ongoing")
            if professor_id:
                # Extended cooldown (8s) to prevent duplicate modals
                recently_seen[f"professor_{professor_id}"] = datetime.datetime.now() + datetime.timedelta(seconds=3)
            # Return success and include optional mismatch warning so UI can notify the user.
            payload = {"success": True, "message": f"✅ Session started — Students have {STUDENT_GRACE_MINUTES} min grace period"}
            if mismatch_msg:
                payload["warning"] = mismatch_msg
            # Audit session start
            try:
                note_text = note_entry if 'note_entry' in locals() and note_entry else ""
            except Exception:
                note_text = ""
            # session start auditing omitted per configuration (engine-level logs only)
            return jsonify(payload)
        if action == "DISMISS":
            supabase.table("lab_sessions").update({
                "status":              "dismissing",
                "actual_dismiss_time": now_local.time().isoformat(),
                "updated_at":          now_store.isoformat()
            }).eq("session_id", session_id).execute()
            if schedule_id:
                update_session_cache(schedule_id, session_id, "dismissing")
            if professor_id:
                # Extended cooldown (8s) to prevent duplicate modals
                recently_seen[f"professor_{professor_id}"] = datetime.datetime.now() + datetime.timedelta(seconds=3)
            # session dismissed auditing omitted per configuration (engine-level logs only)
            return jsonify({"success": True,
                            "message": "✅ Dismissal mode ON — Students may now time out"})
        if action == "END":
            supabase.table("lab_sessions").update({
                "status":          "completed",
                "actual_end_time": now_local.time().isoformat(),
                "updated_at":      now_store.isoformat()
            }).eq("session_id", session_id).execute()
            if schedule_id:
                update_session_cache(schedule_id, session_id, "completed")
            if professor_id:
                # Extended cooldown (8s) to prevent duplicate modals
                recently_seen[f"professor_{professor_id}"] = datetime.datetime.now() + datetime.timedelta(seconds=3)
            att_result = supabase.table("lab_attendance")\
                .select("attendance_id, time_in, student_id")\
                .eq("session_id", session_id)\
                .not_.is_("time_in", "null")\
                .is_("time_out", "null")\
                .execute()
            for att in (att_result.data or []):
                time_in_dt = parse_dt(att["time_in"])
                duration   = int((now_local - time_in_dt).total_seconds() / 60)
                supabase.table("lab_attendance").update({
                    "time_out":         now_store.isoformat(),
                    "duration_minutes": duration,
                    "updated_at":       now_store.isoformat()
                }).eq("attendance_id", att["attendance_id"]).execute()
                invalidate_attendance_cache(session_id, att["student_id"])
            return jsonify({"success": True,
                            "message": "✅ Session ended — remaining students timed out"})
        return jsonify({"success": True, "message": "No action"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

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
def     engine_status():
    with engine_boot_lock:
        payload = dict(engine_boot_state)
    payload["face_db_ready"] = face_db_ready.is_set()
    payload["engine_online"] = True
    payload["machine_lab_assignment"] = _load_machine_lab_config()
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
                students_rows, professors_rows = _fetch_face_rows()
                remote_fingerprint, _ = _build_remote_face_fingerprint(students_rows, professors_rows)

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
        if camera.isOpened():
            camera.release()
            print("✓ Camera hardware released")
        thread_pool.shutdown(wait=False)
        print("✓ Terminating process...")
        os.kill(os.getpid(), signal.SIGTERM)
        return jsonify({"success": True})
    except Exception as e:
        print(f"Error during shutdown: {e}")
        return jsonify({"success": False, "error": str(e)})

def session_cleaner_worker():
    while True:
        try:
            now_store, now_local = get_now()
            today = datetime.date.today()
            day_name = today.strftime("%A")
            current_time_str = now_local.strftime("%H:%M:%S")
            res = supabase.table("lab_sessions")\
                .select("session_id, status, lab_schedules(start_time, end_time)")\
                .eq("session_date", str(today))\
                .in_("status", ["ongoing", "dismissing", "scheduled"])\
                .execute()
            for sess in (res.data or []):
                sch        = sess.get("lab_schedules", {})
                start_time = sch.get("start_time")
                end_time   = sch.get("end_time")
                status     = sess.get("status")
                is_expired = False
                is_voided_by_45_min_rule = False
                if end_time and current_time_str > end_time:
                    is_expired = True
                elif status == "scheduled" and start_time:
                    start_dt = datetime.datetime.combine(today, datetime.time.fromisoformat(start_time))
                    deadline = start_dt + datetime.timedelta(minutes=45)
                    if now_local > deadline:
                        is_expired = True
                        is_voided_by_45_min_rule = True
                if is_expired:
                    session_id = sess["session_id"]
                    if status == "scheduled":
                        reason = ("System Auto-Void: 45-minute grace period elapsed"
                                  if is_voided_by_45_min_rule
                                  else "System Auto-Void: Class ended without professor starting it")
                        supabase.table("lab_sessions").update({
                            "status": "cancelled", "notes": reason,
                            "updated_at": now_store.isoformat()
                        }).eq("session_id", session_id).execute()
                        print(f"Cleanup: Auto-voided unstarted session {session_id}")
                    else:
                        supabase.table("lab_sessions").update({
                            "status": "completed", "actual_end_time": end_time,
                            "notes": "System Auto-End: Schedule time elapsed",
                            "updated_at": now_store.isoformat()
                        }).eq("session_id", session_id).execute()
                        att_res = supabase.table("lab_attendance")\
                            .select("attendance_id, time_in")\
                            .eq("session_id", session_id)\
                            .is_("time_out", "null")\
                            .execute()
                        for att in (att_res.data or []):
                            time_in_dt = parse_dt(att["time_in"])
                            end_dt     = datetime.datetime.combine(today, datetime.time.fromisoformat(end_time))
                            duration   = int((end_dt - time_in_dt).total_seconds() / 60)
                            supabase.table("lab_attendance").update({
                                "time_out":         end_dt.isoformat(),
                                "duration_minutes": max(0, duration),
                                "updated_at":       now_store.isoformat()
                            }).eq("attendance_id", att["attendance_id"]).execute()
                        # session end auditing omitted per configuration (engine-level logs only)
                        # continue cleanup without emitting session_ended audit
                        # (worker continues its loop)
            sched_res = supabase.table("lab_schedules")\
                .select("schedule_id, start_time, end_time")\
                .eq("day_of_week", day_name)\
                .eq("status", "active")\
                .execute()
            for sch in (sched_res.data or []):
                start_time = sch.get("start_time")
                end_time   = sch.get("end_time")
                is_expired = False
                if end_time and current_time_str > end_time:
                    is_expired = True
                elif start_time:
                    start_dt = datetime.datetime.combine(today, datetime.time.fromisoformat(start_time))
                    deadline = start_dt + datetime.timedelta(minutes=45)
                    if now_local > deadline:
                        is_expired = True
                if is_expired:
                    sess_check = supabase.table("lab_sessions")\
                        .select("session_id")\
                        .eq("schedule_id", sch["schedule_id"])\
                        .eq("session_date", str(today))\
                        .execute()
                    if not sess_check.data:
                        supabase.table("lab_sessions").insert({
                            "schedule_id":  sch["schedule_id"],
                            "session_date": str(today),
                            "status":       "cancelled",
                            "notes":        "System Auto-Void: 45-minute grace period elapsed",
                            "created_at":   now_store.isoformat(),
                            "updated_at":   now_store.isoformat()
                        }).execute()
                        print(f"Cleanup: Inserted auto-void for phantom schedule {sch['schedule_id']}")
        except Exception as e:
            print(f"Cleaner Error: {e}")
        time.sleep(60)

threading.Thread(target=session_cleaner_worker, daemon=True).start()
threading.Thread(target=face_auto_sync_worker, daemon=True).start()

# ─────────────────────────────────────────────
# Scanner UI (unchanged)
# ─────────────────────────────────────────────
SCANNER_HTML = r"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Lab Attendance Scanner</title>
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
#card{background:#161b2e;border-radius:18px;padding:30px 28px 26px;max-width:400px;width:92%;border:2px solid #1e3a5f;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.7);animation:pop .1s ease-out}
@keyframes pop{from{opacity:0;transform:scale(.82) translateY(18px)}to{opacity:1;transform:scale(1) translateY(0)}}
#card.green{border-color:#166534}#card.amber{border-color:#92400e}#card.red{border-color:#7f1d1d}#card.blue{border-color:#1e3a5f}#card.orange{border-color:#c2410c}
.avatar{width:60px;height:60px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:26px}
.av-student{background:#166534}.av-prof{background:#1e3a5f}.av-warn{background:#78350f}.av-err{background:#7f1d1d}.av-dismiss{background:#92400e}
#cardName{font-size:1.15rem;font-weight:700;margin-bottom:3px;color:#f1f5f9}
#cardRole{font-size:.82rem;color:#94a3b8;margin-bottom:14px}
#cardMsg{padding:11px 14px;border-radius:9px;font-size:.9rem;line-height:1.5;margin-bottom:18px}
.ms{background:#14532d;color:#bbf7d0}.mw{background:#78350f;color:#fde68a}.me{background:#7f1d1d;color:#fca5a5}.mi{background:#1e3a5f;color:#bae6fd}.mo{background:#7c2d12;color:#fed7aa}
.btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.btn{padding:10px 24px;border-radius:8px;border:none;font-size:13px;font-weight:700;cursor:pointer;transition:all .18s}
#btnOk{background:#166534;color:#fff}#btnOk:hover{background:#14532d;transform:translateY(-1px)}
#btnOk.dismiss-btn{background:#b45309;color:#fff}#btnOk.dismiss-btn:hover{background:#92400e}
#btnOk.end-btn{background:#991b1b;color:#fff}#btnOk.end-btn:hover{background:#7f1d1d}
#btnX{background:#2d3748;color:#cbd5e1}#btnX:hover{background:#4a5568}
#bar{font-size:.78rem;color:#4ade80;letter-spacing:.4px}
#countdown{font-size:.75rem;color:#64748b;margin-top:6px}
</style>
</head>
<body>
<h2><span id="pulse"></span>Lab Attendance — Face Scanner</h2>
<div id="videoWrap"><img src="/video_feed" alt="Live feed"></div>
<div id="bar">● Scanning...</div>
<div id="overlay">
  <div id="card">
    <div id="av" class="avatar av-student">👤</div>
    <div id="cardName"></div>
    <div id="cardRole"></div>
    <div id="cardMsg" class="ms"></div>
    <div class="btns">
      <button id="btnOk" class="btn" onclick="doConfirm()">✅ Confirm</button>
      <button id="btnX"  class="btn" onclick="dismiss()">Dismiss</button>
    </div>
    <div id="countdown"></div>
  </div>
</div>
<script>
let payload=null,timer=null,cd=null,remaining=0;
const ERR_ACTIONS=new Set(['NO_SCHEDULE','NOT_ENROLLED','SESSION_NOT_STARTED','SESSION_ENDED','TOO_EARLY','SCHEDULE_ENDED','COMPLETED','SESSION_VOIDED','SESSION_ALREADY_ENDED','NO_VALID_SCHEDULE','CANNOT_TIME_OUT','SESSION_CANCELLED','SPOOF_DETECTED']);
function connectSSE(){const es=new EventSource('/attendee_stream');es.onmessage=e=>show(JSON.parse(e.data));es.onerror=()=>{es.close();setTimeout(connectSSE,500);};}
connectSSE();
function show(data){
  clearInterval(cd);clearTimeout(timer);payload=data;
  const action=data.action||'',role=data.role||'student',isErr=ERR_ACTIONS.has(action);
  if(action==='LOADING'){
    const av=document.getElementById('av');
    av.className='avatar '+(role==='professor'?'av-prof':'av-student');
    av.textContent=role==='professor'?'👨‍🏫':'🎓';
    document.getElementById('cardName').textContent=data.name||'';
    document.getElementById('cardRole').textContent=role==='professor'?'Professor':'Student';
    document.getElementById('card').className='blue';
    const msgEl=document.getElementById('cardMsg');msgEl.textContent='Checking schedule...';msgEl.className='mi';
    document.getElementById('btnOk').style.display='none';
    document.getElementById('overlay').classList.add('on');return;
  }
  const card=document.getElementById('card');
  card.dataset.isLate=data.is_late?'1':'0';card.dataset.lateMinutes=data.late_minutes||0;
  const av=document.getElementById('av');
  if(isErr){av.className='avatar av-err';av.textContent='❌';card.className='red';}
  else if(action==='DISMISS'){av.className='avatar av-dismiss';av.textContent='🚪';card.className='orange';}
  else if(data.is_late){av.className='avatar av-warn';av.textContent='⚠';card.className='amber';}
  else{av.className='avatar '+(role==='professor'?'av-prof':'av-student');av.textContent=role==='professor'?'👨‍🏫':'🎓';card.className='green';}
  document.getElementById('cardName').textContent=data.name||'';
  document.getElementById('cardRole').textContent=role==='professor'?'Professor':'Student';
  const msgObj=resolveMsg(data,isErr);
  const msgEl=document.getElementById('cardMsg');msgEl.textContent=msgObj.txt;msgEl.className=msgObj.cls;
  const btn=document.getElementById('btnOk');
  btn.style.display=isErr?'none':'block';btn.className='btn';
  if(action==='DISMISS')btn.classList.add('dismiss-btn');
  if(action==='END')btn.classList.add('end-btn');
  btn.textContent=label(action);
  document.getElementById('overlay').classList.add('on');
  if(!isErr&&role==='student'&&(action==='IN'||action==='OUT')){
    btn.style.display='none';document.getElementById('countdown').textContent='Saving to database...';doConfirm(true);
  }else{remaining=4;updateCD();cd=setInterval(()=>{remaining--;updateCD();if(remaining<=0)dismiss();},1000);}
}
function updateCD(){document.getElementById('countdown').textContent=remaining>0?`Auto-dismiss in ${remaining}s`:'';}
function resolveMsg(d,isErr){
  d.is_late=d.is_late||(document.getElementById('card').dataset.isLate==='1');
  d.late_minutes=d.late_minutes||document.getElementById('card').dataset.lateMinutes||0;
  if(d.error)return{txt:d.error,cls:(d.action==='SESSION_NOT_STARTED'||d.action==='CANNOT_TIME_OUT')?'mw':(isErr?'me':'mw')};
    const map={IN:{txt:d.is_late?`⚠ LATE by ${d.late_minutes} min. Saving Time IN...`:'Saving Time IN...',cls:d.is_late?'mw':'ms'},OUT:{txt:'Saving Time OUT...',cls:'ms'},START:{txt:'Tap Confirm to START the session.',cls:'ms'},DISMISS:{txt:'🚪 Allow students to TIME OUT and leave the lab.',cls:'mo'},END:{txt:'⏹ End the session completely.',cls:'mw'},COMPLETED:{txt:'Attendance already complete for this session.',cls:'mi'},SPOOF_DETECTED:{txt:'Liveness check failed. Please present a real face to the camera.',cls:'me'}};
  return map[d.action]||{txt:d.action,cls:'mi'};
}
function label(a){return{IN:'✅ Time IN',OUT:'✅ Time OUT',START:'▶ Start Session',DISMISS:'🚪 Allow Time Out',END:'⏹ End Session'}[a]||'✅ Confirm';}
async function doConfirm(isAuto=false){
  if(!payload)return;const d=payload;
  if(!isAuto)dismiss();
  const ep=d.role==='professor'?'/confirm_session':'/confirm_attendance';
  try{
    const r=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    const json=await r.json();
    const bar=document.getElementById('bar');bar.textContent='● '+(json.message||'Done');
        if(!json.success){
            document.getElementById('card').className='red';
            document.getElementById('av').className='avatar av-err';
            document.getElementById('av').textContent='❌';
            document.getElementById('cardMsg').textContent=json.message||'Unable to save attendance.';
            document.getElementById('cardMsg').className='me';
            document.getElementById('countdown').textContent='Rejected';
            setTimeout(()=>dismiss(), isAuto ? 4000 : 5000);
            return;
        }
        if(isAuto){document.getElementById('cardMsg').textContent=json.message||'Saved!';document.getElementById('cardMsg').className='ms';document.getElementById('countdown').textContent='Saved successfully ✅';setTimeout(()=>dismiss(),1500);}
        else{setTimeout(()=>{bar.textContent='● Scanning...';},3000);}
  }catch(e){console.error(e);}
}
function dismiss(){clearInterval(cd);clearTimeout(timer);document.getElementById('overlay').classList.remove('on');payload=null;}
</script>
</body>
</html>"""

@app.route('/scanner')
def scanner():
    return SCANNER_HTML

@app.route('/')
def index():
    return ('<h2 style="font-family:sans-serif;padding:20px">Lab Attendance ✓ &nbsp;'
            '<a href="/scanner">Open Scanner →</a></h2>')

if __name__ == '__main__':
    threading.Thread(target=load_all_faces, kwargs={"force_rebuild": FORCE_FACE_CACHE_REBUILD}, daemon=True).start()
    threading.Thread(target=refresh_session_cache, daemon=True).start()
    print("=" * 60)
    print("Lab Attendance — Supabase Edition ✓")
    print("Face DB load      : incremental background sync")
    print(f"Faces/person      : up to {max(1, MAX_IMAGES_PER_PERSON)} image(s)")
    print(f"Grace period      : {STUDENT_GRACE_MINUTES} min after professor starts")
    print(f"Session cache TTL : {CACHE_TTL}s")
    print("Scanner UI        : http://127.0.0.1:5000/scanner")
    print("=" * 60)
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True, use_reloader=False)