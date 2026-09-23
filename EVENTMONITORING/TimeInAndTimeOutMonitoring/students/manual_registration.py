import os
import sys
import time
import shutil
import requests
import cv2
import numpy as np
import dlib
import mediapipe as mp

from dotenv import load_dotenv
from supabase import create_client, Client


# ============================================================
# CONFIGURATION
# ============================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Load .env
ENV_PATH = os.path.join(SCRIPT_DIR, ".env")
load_dotenv(ENV_PATH, override=True)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

BUCKET_NAME = "facial_data"

# Existing attendance-engine rebuild endpoint
ATTENDANCE_TRIGGER = os.getenv(
    "ATTENDANCE_TRIGGER",
    "http://127.0.0.1:5000/trigger_rebuild"
)

ATTENDANCE_TRIGGER_TOKEN = (
    os.getenv("ATTENDANCE_TRIGGER_TOKEN")
    or os.getenv("REBUILD_SECRET")
    or ""
).strip()

# Input folder
INPUT_DIR = os.path.join(SCRIPT_DIR, "manual_registration")

# Processed images will be placed here
PROCESSED_DIR = os.path.join(
    SCRIPT_DIR,
    "manual_registration_processed"
)

# Six students currently being handled
STUDENTS = [
    "Alpuerto",
    "Aquino",
    "Bitancor",
    "Fernandez",
    "Galinato",
    "Salazar",
 
]


# ============================================================
# CHECK CONFIGURATION
# ============================================================

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: SUPABASE_URL or SUPABASE_KEY is missing.")
    print(f"Check your .env file at: {ENV_PATH}")
    sys.exit(1)


# ============================================================
# SUPABASE
# ============================================================

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY
)

print("✓ Supabase client connected")


# ============================================================
# DLIB HOG + SVM
# ============================================================

hog_detector = dlib.get_frontal_face_detector()

print("✓ dlib HOG + SVM detector loaded")


# ============================================================
# MEDIAPIPE
# ============================================================

mp_selfie_segmentation = mp.solutions.selfie_segmentation

segmentor = mp_selfie_segmentation.SelfieSegmentation(
    model_selection=0
)

print("✓ MediaPipe Selfie Segmentation loaded")


# ============================================================
# IMAGE SETTINGS
# ============================================================

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".jfif", ".webp", ".bmp"}

MIN_FACE_SIZE = 80

# Padding around detected face
FACE_PADDING = 0.35

# MediaPipe threshold
SEGMENTATION_THRESHOLD = 0.5


# ============================================================
# HELPER FUNCTIONS
# ============================================================

def normalize_name(name):
    """
    Normalize names for comparison.
    """
    return " ".join(
        str(name).strip().lower().split()
    )


def get_image_files(folder):
    """
    Return supported image files sorted by filename.
    """

    if not os.path.isdir(folder):
        return []

    files = []

    for filename in os.listdir(folder):

        path = os.path.join(folder, filename)

        if not os.path.isfile(path):
            continue

        ext = os.path.splitext(filename)[1].lower()

        if ext in SUPPORTED_EXTENSIONS:
            files.append(path)

    return sorted(files)


def find_student(last_name):
    """
    Find exactly one student in Supabase using last name.

    Uses stud_id for the registration/storage path,
    matching your existing registration script.
    """

    print(f"\n[DATABASE] Looking for student: {last_name}")

    try:

        response = (
            supabase
            .table("students")
            .select(
                "student_id, stud_id, first_name, last_name"
            )
            .ilike("last_name", last_name)
            .execute()
        )

        rows = response.data or []

    except Exception as e:

        print(f"[DATABASE] ERROR while searching: {e}")

        return None

    if len(rows) == 0:

        print(
            f"[DATABASE] ✗ No student found with last name "
            f"'{last_name}'"
        )

        return None

    if len(rows) > 1:

        print(
            f"[DATABASE] ⚠ Multiple students found with "
            f"last name '{last_name}'."
        )

        for row in rows:
            print(
                f"    {row.get('first_name')} "
                f"{row.get('last_name')} "
                f"(stud_id={row.get('stud_id')})"
            )

        print(
            "[DATABASE] Skipping this student to avoid "
            "uploading photos to the wrong account."
        )

        return None

    student = rows[0]

    print(
        f"[DATABASE] ✓ Found: "
        f"{student.get('first_name')} "
        f"{student.get('last_name')}"
    )

    print(
        f"[DATABASE] stud_id = {student.get('stud_id')}"
    )

    return student


def detect_face(image):
    """
    Detect faces using dlib HOG + SVM.

    Returns:
        rectangle, score
    """

    gray = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2GRAY
    )

    # Run HOG detector
    rectangles, scores, _ = hog_detector.run(
        gray,
        1,
        0
    )

    if len(rectangles) == 0:
        return None, None

    # If multiple faces exist, use largest face
    candidates = []

    for rect, score in zip(rectangles, scores):

        width = rect.right() - rect.left()
        height = rect.bottom() - rect.top()

        area = width * height

        candidates.append(
            (area, rect, score)
        )

    candidates.sort(
        key=lambda x: x[0],
        reverse=True
    )

    _, best_rect, best_score = candidates[0]

    return best_rect, best_score


def crop_face(image, rect):
    """
    Crop the detected face with padding.
    """

    h, w = image.shape[:2]

    left = rect.left()
    top = rect.top()
    right = rect.right()
    bottom = rect.bottom()

    face_width = right - left
    face_height = bottom - top

    pad_x = int(face_width * FACE_PADDING)
    pad_y = int(face_height * FACE_PADDING)

    left = max(0, left - pad_x)
    top = max(0, top - pad_y)
    right = min(w, right + pad_x)
    bottom = min(h, bottom + pad_y)

    crop = image[
        top:bottom,
        left:right
    ]

    return crop


def apply_mediapipe_segmentation(face_crop):
    """
    Apply MediaPipe Selfie Segmentation.

    Returns:
        processed BGRA image
        statistics dictionary
    """

    if face_crop is None or face_crop.size == 0:
        return None, None

    rgb = cv2.cvtColor(
        face_crop,
        cv2.COLOR_BGR2RGB
    )

    start = time.time()

    result = segmentor.process(rgb)

    elapsed_ms = (
        time.time() - start
    ) * 1000.0

    if result.segmentation_mask is None:
        print(
            "[MEDIAPIPE] ✗ No segmentation mask returned."
        )

        return None, None

    mask_float = result.segmentation_mask

    person_mask = (
        mask_float >= SEGMENTATION_THRESHOLD
    ).astype(np.uint8) * 255

    # Smooth the mask slightly
    kernel = np.ones(
        (3, 3),
        np.uint8
    )

    person_mask = cv2.morphologyEx(
        person_mask,
        cv2.MORPH_OPEN,
        kernel
    )

    person_mask = cv2.morphologyEx(
        person_mask,
        cv2.MORPH_CLOSE,
        kernel
    )

    # Statistics
    total_pixels = mask_float.size

    person_pixels = int(
        np.sum(person_mask > 0)
    )

    mean_confidence = float(
        mask_float.mean()
    )

    # Convert BGR -> BGRA
    bgra = cv2.cvtColor(
        face_crop,
        cv2.COLOR_BGR2BGRA
    )

    # Use segmentation as alpha channel
    bgra[:, :, 3] = person_mask

    stats = {
        "inference_ms": elapsed_ms,
        "mean_confidence": mean_confidence,
        "person_pixels": person_pixels,
        "total_pixels": total_pixels,
        "person_percentage": (
            person_pixels /
            total_pixels *
            100.0
        )
    }

    return bgra, stats


def process_one_image(
    input_path,
    output_path,
    student_name,
    photo_number
):
    """
    Process one submitted photograph.
    """

    print("\n" + "-" * 60)

    print(
        f"[PROCESS] {student_name} "
        f"PHOTO {photo_number}"
    )

    print(
        f"[PROCESS] Input: {input_path}"
    )

    image = cv2.imread(
        input_path,
        cv2.IMREAD_COLOR
    )

    if image is None:

        print(
            "[PROCESS] ✗ Could not read image."
        )

        return False

    original_h, original_w = image.shape[:2]

    print(
        f"[OPENCV] Original image: "
        f"{original_w}x{original_h}px"
    )

    # --------------------------------------------------------
    # HOG + SVM
    # --------------------------------------------------------

    start = time.time()

    rect, score = detect_face(image)

    detection_ms = (
        time.time() - start
    ) * 1000.0

    if rect is None:

        print(
            "[HOG+SVM] ✗ No face detected."
        )

        return False

    face_width = (
        rect.right() - rect.left()
    )

    face_height = (
        rect.bottom() - rect.top()
    )

    print(
        f"[HOG+SVM] ✓ Face detected"
    )

    print(
        f"[HOG+SVM] Bounding box: "
        f"x={rect.left()} "
        f"y={rect.top()} "
        f"w={face_width} "
        f"h={face_height}"
    )

    print(
        f"[HOG+SVM] SVM score: "
        f"{score:.4f}"
    )

    print(
        f"[HOG+SVM] Detection time: "
        f"{detection_ms:.1f}ms"
    )

    # Reject extremely small faces
    if (
        face_width < MIN_FACE_SIZE
        or face_height < MIN_FACE_SIZE
    ):

        print(
            f"[HOG+SVM] ✗ Face too small "
            f"({face_width}x{face_height}px)"
        )

        return False

    # --------------------------------------------------------
    # FACE CROP
    # --------------------------------------------------------

    face_crop = crop_face(
        image,
        rect
    )

    if face_crop is None or face_crop.size == 0:

        print(
            "[CROP] ✗ Face crop failed."
        )

        return False

    crop_h, crop_w = face_crop.shape[:2]

    print(
        f"[CROP] ✓ Face crop: "
        f"{crop_w}x{crop_h}px"
    )

    # --------------------------------------------------------
    # MEDIAPIPE
    # --------------------------------------------------------

    processed, stats = (
        apply_mediapipe_segmentation(
            face_crop
        )
    )

    if processed is None:

        print(
            "[MEDIAPIPE] ✗ Processing failed."
        )

        return False

    print(
        f"[MEDIAPIPE] ✓ Processed"
    )

    print(
        f"[MEDIAPIPE] Inference: "
        f"{stats['inference_ms']:.1f}ms"
    )

    print(
        f"[MEDIAPIPE] Mean confidence: "
        f"{stats['mean_confidence']:.3f}"
    )

    print(
        f"[MEDIAPIPE] Person pixels: "
        f"{stats['person_percentage']:.1f}%"
    )

    # --------------------------------------------------------
    # SAVE
    # --------------------------------------------------------

    os.makedirs(
        os.path.dirname(output_path),
        exist_ok=True
    )

    success = cv2.imwrite(
        output_path,
        processed
    )

    if not success:

        print(
            "[SAVE] ✗ Failed to save image."
        )

        return False

    file_size_kb = (
        os.path.getsize(output_path)
        / 1024.0
    )

    print(
        f"[SAVE] ✓ Saved: {output_path}"
    )

    print(
        f"[SAVE] Size: "
        f"{processed.shape[1]}x"
        f"{processed.shape[0]}px "
        f"({file_size_kb:.1f} KB)"
    )

    return True


# ============================================================
# UPLOAD
# ============================================================

def upload_student_images(
    student,
    processed_folder,
    processed_files
):
    """
    Upload processed photos to:

        facial_data/students/student_<stud_id>/

    and update facial_dataset_path.
    """

    stud_id = student.get("stud_id")

    first_name = student.get(
        "first_name",
        ""
    )

    last_name = student.get(
        "last_name",
        ""
    )

    if not stud_id:

        print(
            "[UPLOAD] ✗ Student has no stud_id."
        )

        return False

    cloud_folder = (
        f"students/student_{stud_id}"
    )

    print("\n" + "=" * 60)

    print(
        f"[UPLOAD] {first_name} {last_name}"
    )

    print(
        f"[UPLOAD] Target: "
        f"{cloud_folder}"
    )

    uploaded = 0

    for local_path in processed_files:

        filename = os.path.basename(
            local_path
        )

        cloud_path = (
            f"{cloud_folder}/{filename}"
        )

        try:

            file_size_kb = (
                os.path.getsize(local_path)
                / 1024.0
            )

            print(
                f"[UPLOAD] Uploading "
                f"{filename}..."
            )

            with open(
                local_path,
                "rb"
            ) as f:

                supabase.storage \
                    .from_(BUCKET_NAME) \
                    .upload(
                        file=f,
                        path=cloud_path,
                        file_options={
                            "content-type": "image/png",
                            "upsert": "true"
                        }
                    )

            uploaded += 1

            print(
                f"[UPLOAD] ✓ {filename} "
                f"({file_size_kb:.1f} KB)"
            )

        except Exception as e:

            print(
                f"[UPLOAD] ✗ {filename}: "
                f"{e}"
            )

    print(
        f"[UPLOAD] Result: "
        f"{uploaded}/{len(processed_files)}"
    )

    # Require at least 3 photos,
    # matching your existing registration code.
    if uploaded < 3:

        print(
            "[UPLOAD] ✗ Registration not finalized."
        )

        print(
            "[UPLOAD] At least 3 successful "
            "uploads are required."
        )

        return False

    # --------------------------------------------------------
    # UPDATE DATABASE
    # --------------------------------------------------------

    try:

        supabase \
            .table("students") \
            .update({
                "facial_dataset_path":
                    cloud_folder
            }) \
            .eq(
                "stud_id",
                stud_id
            ) \
            .execute()

        print(
            "[DATABASE] ✓ facial_dataset_path "
            "updated."
        )

    except Exception as e:

        print(
            f"[DATABASE] ✗ Update failed: "
            f"{e}"
        )

        return False

    return True


# ============================================================
# TRIGGER FACE REBUILD
# ============================================================

def trigger_rebuild():
    """
    Ask the existing attendance engine
    to rebuild the face encoding cache.
    """

    print("\n" + "=" * 60)

    print(
        "[REBUILD] Triggering attendance "
        "face-data rebuild..."
    )

    headers = {
        "Content-Type":
            "application/json"
    }

    if ATTENDANCE_TRIGGER_TOKEN:

        headers[
            "X-REBUILD-TOKEN"
        ] = ATTENDANCE_TRIGGER_TOKEN

    try:

        response = requests.post(
            ATTENDANCE_TRIGGER,
            json={
                "force": False
            },
            headers=headers,
            timeout=5
        )

        if response.status_code == 409:

            print(
                "[REBUILD] ⚠ Rebuild already "
                "in progress."
            )

        elif response.ok:

            print(
                f"[REBUILD] ✓ Rebuild accepted "
                f"(HTTP {response.status_code})"
            )

        else:

            print(
                f"[REBUILD] ✗ Server returned "
                f"HTTP {response.status_code}"
            )

            print(
                response.text[:500]
            )

    except Exception as e:

        print(
            "[REBUILD] ✗ Could not contact "
            "attendance engine."
        )

        print(
            f"[REBUILD] {e}"
        )

        print(
            "[REBUILD] Your photos are still "
            "uploaded. Start the attendance "
            "engine and trigger a rebuild "
            "manually if necessary."
        )


# ============================================================
# PROCESS ONE STUDENT
# ============================================================

def process_student(last_name):

    print("\n\n")
    print("#" * 70)
    print(
        f"# PROCESSING STUDENT: {last_name}"
    )
    print("#" * 70)

    input_folder = os.path.join(
        INPUT_DIR,
        last_name
    )

    output_folder = os.path.join(
        PROCESSED_DIR,
        last_name
    )

    # --------------------------------------------------------
    # Check folder
    # --------------------------------------------------------

    if not os.path.isdir(input_folder):

        print(
            f"[INPUT] ✗ Folder does not exist:"
        )

        print(
            f"        {input_folder}"
        )

        return False

    # --------------------------------------------------------
    # Find photos
    # --------------------------------------------------------

    image_files = get_image_files(
        input_folder
    )

    print(
        f"[INPUT] Found "
        f"{len(image_files)} image(s)."
    )

    if len(image_files) != 5:

        print(
            f"[INPUT] ✗ Expected exactly "
            f"5 photos."
        )

        print(
            f"[INPUT] Found: "
            f"{len(image_files)}"
        )

        return False

    # --------------------------------------------------------
    # Find student in DB
    # --------------------------------------------------------

    student = find_student(
        last_name
    )

    if student is None:

        return False

    # --------------------------------------------------------
    # Process photos
    # --------------------------------------------------------

    os.makedirs(
        output_folder,
        exist_ok=True
    )

    processed_files = []

    for index, input_path in enumerate(
        image_files,
        start=1
    ):

        output_path = os.path.join(
            output_folder,
            f"{index}.png"
        )

        success = process_one_image(
            input_path,
            output_path,
            last_name,
            index
        )

        if success:

            processed_files.append(
                output_path
            )

        else:

            print(
                f"\n[STUDENT] ✗ Photo "
                f"{index} failed."
            )

    # --------------------------------------------------------
    # Require all five photos
    # --------------------------------------------------------

    if len(processed_files) != 5:

        print("\n" + "!" * 60)

        print(
            f"[STUDENT] ✗ {last_name} "
            f"was NOT uploaded."
        )

        print(
            f"[STUDENT] Only "
            f"{len(processed_files)}/5 "
            f"photos passed processing."
        )

        print(
            "[STUDENT] Fix the failed "
            "photos and run again."
        )

        print("!" * 60)

        return False

    # --------------------------------------------------------
    # Upload
    # --------------------------------------------------------

    success = upload_student_images(
        student,
        output_folder,
        processed_files
    )

    if not success:

        return False

    print("\n" + "#" * 70)

    print(
        f"# ✓ {last_name} COMPLETED"
    )

    print("#" * 70)

    return True


# ============================================================
# MAIN
# ============================================================

def main():

    print("\n")
    print("=" * 70)
    print(" MANUAL FACIAL DATASET REGISTRATION")
    print("=" * 70)

    print(
        "\nThis script processes the submitted "
        "5-photo datasets."
    )

    print(
        "\nStudents:"
    )

    for name in STUDENTS:

        print(
            f"  • {name}"
        )

    print(
        f"\nInput directory:"
        f"\n{INPUT_DIR}"
    )

    print(
        f"\nProcessed directory:"
        f"\n{PROCESSED_DIR}"
    )

    print(
        "\nPipeline:"
    )

    print(
        "Photos"
        " -> dlib HOG + SVM"
        " -> Face Crop"
        " -> MediaPipe"
        " -> PNG"
        " -> Supabase"
    )

    print(
        "\n" + "=" * 70
    )

    # --------------------------------------------------------
    # Check input directory
    # --------------------------------------------------------

    if not os.path.isdir(INPUT_DIR):

        print(
            f"\nERROR: Input directory does "
            f"not exist:\n{INPUT_DIR}"
        )

        print(
            "\nCreate it and place the "
            "student folders inside."
        )

        return

    # --------------------------------------------------------
    # Process students
    # --------------------------------------------------------

    successful = []
    failed = []

    for last_name in STUDENTS:

        success = process_student(
            last_name
        )

        if success:

            successful.append(
                last_name
            )

        else:

            failed.append(
                last_name
            )

    # --------------------------------------------------------
    # Summary
    # --------------------------------------------------------

    print("\n\n")
    print("=" * 70)
    print(" FINAL SUMMARY")
    print("=" * 70)

    print(
        f"\n✓ Successfully processed: "
        f"{len(successful)}"
    )

    for name in successful:

        print(
            f"    ✓ {name}"
        )

    print(
        f"\n✗ Failed: "
        f"{len(failed)}"
    )

    for name in failed:

        print(
            f"    ✗ {name}"
        )

    # --------------------------------------------------------
    # Rebuild only if at least one succeeded
    # --------------------------------------------------------

    if successful:

        trigger_rebuild()

    print("\n" + "=" * 70)

    print(
        "MANUAL REGISTRATION FINISHED"
    )

    print("=" * 70)


if __name__ == "__main__":

    try:

        main()

    except KeyboardInterrupt:

        print(
            "\n\nProcess cancelled by user."
        )

    except Exception as e:

        print(
            "\n\nCRITICAL ERROR:"
        )

        print(e)