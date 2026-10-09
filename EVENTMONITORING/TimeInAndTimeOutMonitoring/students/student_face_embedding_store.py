"""Server-only persistence helpers for individual student face references.

The caller supplies encodings from real, usable images. Never expose these
vectors through browser routes or include them in logs or audit details.
"""

import numpy as np
import uuid


def new_student_face_folder(stud_id):
    """Use a fresh Storage folder so partial re-enrolment cannot mix batches."""
    if not stud_id or "/" in str(stud_id) or "\\" in str(stud_id):
        raise ValueError("Invalid student ID for face dataset path")
    return f"students/student_{stud_id}/registration_{uuid.uuid4().hex}"


def checked_vector(raw):
    if raw is None:
        return None
    try:
        if isinstance(raw, str):
            values = [float(part) for part in raw.strip().strip("[]").split(",")]
        else:
            values = raw
        vector = np.asarray(values, dtype=np.float32)
    except (TypeError, ValueError):
        return None
    if vector.shape != (128,) or not np.isfinite(vector).all():
        return None
    return vector


def vector_literal(raw):
    vector = checked_vector(raw)
    if vector is None:
        raise ValueError("A finite 128-dimensional face encoding is required")
    # Round-trip the exact float32 components into pgvector rather than
    # truncating them to a fixed decimal count.
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


def fetch_student_embedding_rows(client):
    """Read every private row with the LOCAL_GATE service-role client."""
    rows_by_student = {}
    offset = 0
    page_size = 500
    while True:
        response = (
            client.table("student_face_embeddings")
            .select("student_id,image_slot,embedding,source_image_name,dataset_fingerprint")
            .order("student_id")
            .order("image_slot")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        page = response.data or []
        for row in page:
            rows_by_student.setdefault(str(row["student_id"]), []).append(row)
        if len(page) < page_size:
            break
        offset += page_size
    return rows_by_student


def verified_student_embeddings(rows, fingerprint):
    """Return ordered samples only when one complete DB set matches Storage."""
    if not rows or not fingerprint:
        return None
    seen_slots = set()
    seen_names = set()
    vectors = []
    for row in sorted(rows, key=lambda item: item["image_slot"]):
        slot = row.get("image_slot")
        name = row.get("source_image_name")
        vector = checked_vector(row.get("embedding"))
        if (row.get("dataset_fingerprint") != fingerprint or vector is None
                or not isinstance(slot, int) or slot not in range(1, 6)
                or not name or slot in seen_slots or name in seen_names):
            return None
        seen_slots.add(slot)
        seen_names.add(name)
        vectors.append(vector)
    return vectors


def replace_student_embeddings(client, student_id, dataset_path, fingerprint, samples):
    """Replace samples and average in one database RPC transaction."""
    if not samples or len(samples) > 5:
        raise ValueError("One to five real image encodings are required")
    payload = []
    seen_slots = set()
    seen_names = set()
    for sample in samples:
        slot = sample["image_slot"]
        name = sample["source_image_name"]
        if (not isinstance(slot, int) or slot not in range(1, 6)
                or not isinstance(name, str) or not name
                or slot in seen_slots or name in seen_names):
            raise ValueError("Duplicate or invalid face image source")
        seen_slots.add(slot)
        seen_names.add(name)
        payload.append({"image_slot": slot,
                        "source_image_name": name,
                        "embedding": vector_literal(sample["embedding"])})
    result = client.rpc("replace_student_face_embedding_set", {
        "p_student_id": str(student_id),
        "p_dataset_path": dataset_path,
        "p_fingerprint": fingerprint,
        "p_samples": payload,
    }).execute()
    if result.data != len(samples):
        raise RuntimeError("Incomplete student face embedding replacement")
    return len(samples)
