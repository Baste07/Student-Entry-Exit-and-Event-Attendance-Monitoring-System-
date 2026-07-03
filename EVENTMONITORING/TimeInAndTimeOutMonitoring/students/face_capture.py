import sys, os

# 1. Define the exact folder path
script_dir = os.path.dirname(os.path.abspath(__file__))

# 2. Redirect logs to a file so pythonw.exe never crashes silently
log_path = os.path.join(script_dir, "registration_log.txt")
sys.stdout = open(log_path, "w", encoding="utf-8", buffering=1)
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

def ensure_capture_ready():
    global cap, segmentor, capture_thread, capture_running, latest_frame
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
    "paths": [],
    "last_t": 0,
    "done_t": 0,
    "countdown_done": False, 
    "align_start_t": 0       
}

def upload_to_supabase():
    global session
    role = session.get("role", "student")

    _audit_event("upload_start", {"id_number": session.get("id_number"), "role": role, "paths": ",".join(session.get("paths", []))})

    if role == "professor":
        cloud_folder = f"professors/professor_{session['id_number']}"
        table_name   = "professors"
        id_column    = "employee_id"
    else:
        cloud_folder = f"students/student_{session['id_number']}"
        table_name   = "students"
        id_column    = "id_number"

    valid_count = 0
    current_paths = list(session["paths"])

    for p in current_paths:
        if not os.path.exists(p): continue
        filename = os.path.basename(p)
        try:
            with open(p, 'rb') as f:
                supabase.storage.from_(BUCKET_NAME).upload(
                    file=f, path=f"{cloud_folder}/{filename}",
                    file_options={"content-type": "image/png", "upsert": "true"}
                )
            valid_count += 1
            os.remove(p)
        except Exception as e:
            print(f"Upload Error: {e}")

    if valid_count >= 3:
        try:
            supabase.table(table_name).update({"facial_dataset_path": cloud_folder}).eq(id_column, session["id_number"]).execute()
            session["completed"] = True
            session["done_t"] = time.time()
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

                    print(f"Trigger rebuild response: {resp.status_code} {friendly_text}")
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
                    small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
                    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
                    locs = face_recognition.face_locations(rgb, model="hog")
                    last_locs = [(t*4, r*4, b*4, l*4) for (t, r, b, l) in locs]
                
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
                        
                        if normalized_dist <= 0.4:  # Reduced from 0.85
                            # 2. STRICTER SIZE CHECK: Force the user to fill the oval
                            if face_w < rx * 1.3:   # Increased from 0.9. Face must be wider
                                guidance_text = "Come closer! Fill the oval."
                            elif face_w > rx * 1.8: # Face is too large
                                guidance_text = "Move back a little."
                            else:
                                is_aligned = True
                                aligned_face = (t, r, b, l)
                                current_center = (face_cx, face_cy)
                        else:
                            guidance_text = "Center your face exactly in the oval"
                
                # --- STABILITY CHECK ALGORITHM ---
                if is_aligned and current_center:
                    center_history.append(current_center)
                    if len(center_history) > 8: 
                        center_history.pop(0)
                    
                    if len(center_history) >= 5:
                        cxs = [pt[0] for pt in center_history]
                        cys = [pt[1] for pt in center_history]
                        
                        max_movement_x = max(cxs) - min(cxs)
                        max_movement_y = max(cys) - min(cys)
                        
                        if max_movement_x < 10 and max_movement_y < 10: 
                            is_steady = True
                else:
                    center_history.clear() 
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
                                result = segmentor.process(rgb_crop)
                                
                                person_mask = (result.segmentation_mask > 0.5).astype(np.uint8) * 255
                                oval_mask = np.zeros(cropped_rect.shape[:2], dtype=np.uint8)
                                local_cx = cropped_rect.shape[1] // 2
                                local_cy = cropped_rect.shape[0] // 2
                                cv2.ellipse(oval_mask, (local_cx, local_cy), (rx, ry), 0, 0, 360, 255, -1)
                                
                                final_mask = cv2.bitwise_and(person_mask, oval_mask)
                                
                                cropped_bgra = cv2.cvtColor(cropped_rect, cv2.COLOR_BGR2BGRA)
                                cropped_bgra[:, :, 3] = final_mask  
                                
                                p = f"{session['count'] + 1}.png"
                                cv2.imwrite(p, cropped_bgra)
                                
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
        "paths": [],
        "last_t": time.time(),
        "countdown_done": False, 
        "align_start_t": 0       
    })
    session["flow_id"] = f"registration::{session.get('id_number')}::{int(time.time())}"
    session["flow_label"] = f"Face Capture Registration {session.get('id_number')}"
    _audit_event("registration_started", {"id_number": session.get("id_number"), "role": session.get("role")})
    return jsonify({"status": "ready"})

@app.route('/status')
def status(): 
    return jsonify(session)

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/shutdown', methods=['POST'])
def shutdown():
    global cap, capture_running, latest_frame
    try:
        capture_running = False
        latest_frame = None
        if cap is not None and cap.isOpened():
            cap.release()
            cap = None
    except Exception:
        pass
    os.kill(os.getpid(), signal.SIGTERM)
    return jsonify({"status": "shutting down"})

@app.route('/')
def index():
    return jsonify({"status": "running", "message": "Face Capture Engine is active"})

if __name__ == "__main__":
    app.run(host='127.0.0.1', port=5001, threaded=True)