"""Disposable Development-only database/cache test; prints no biometric values."""

import json
import os
import pathlib
import subprocess
import sys
import uuid
from unittest.mock import patch

import numpy as np
from supabase import create_client


ROOT = pathlib.Path(__file__).resolve().parents[3]
STUDENTS_DIR = ROOT / "EVENTMONITORING" / "TimeInAndTimeOutMonitoring" / "students"
ARTIFACTS = ROOT / ".artifacts"
DEV_REF = "ehyqvyglirirktfmdezq"


def development_config():
    values = {}
    for line in (ROOT / ".env.development.local").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip().strip("\"'")
    if values.get("SUPABASE_URL", "").rstrip("/") != f"https://{DEV_REF}.supabase.co":
        raise RuntimeError("Development project-ref check failed")
    if not values.get("SUPABASE_SERVICE_ROLE_KEY") or not values.get("SUPABASE_ANON_KEY"):
        raise RuntimeError("Development test keys unavailable")
    return values


def configure_isolated_engine(values):
    ARTIFACTS.mkdir(exist_ok=True)
    os.environ["SUPABASE_URL"] = values["SUPABASE_URL"]
    os.environ["SUPABASE_KEY"] = values["SUPABASE_SERVICE_ROLE_KEY"]
    os.environ["LOCAL_GATE_ENV_FILE"] = str(ARTIFACTS / "no-production-env-for-face-test")
    os.environ["LOCAL_GATE_ENGINE_LOG_FILE"] = str(ARTIFACTS / "face-engine-dev-test.log")
    os.environ["LOCAL_GATE_FACE_CACHE_FILE"] = str(ARTIFACTS / "face-cache-dev-test.npz")
    os.environ["LOCAL_GATE_FACE_TEST_MODE"] = "1"
    os.environ["MAX_IMAGES_PER_PERSON"] = "5"


def source_images():
    return [{"name": f"{slot}.png", "updated_at": "2026-10-08T00:00:00Z",
             "id": f"disposable-image-{slot}"} for slot in range(1, 6)]


def load_engine(path):
    sys.path.insert(0, str(STUDENTS_DIR))
    import flask_attendance as engine
    images = source_images()
    engine._list_face_images_for_folder = lambda folder: images if folder == path else []
    return engine


def child_restore(student_id, path):
    original_stdout = sys.stdout
    values = development_config()
    configure_isolated_engine(values)
    engine = load_engine(path)
    engine.load_all_faces(force_rebuild=False)
    references = sum(meta.get("id") == student_id for meta in engine.known_meta)
    cache_path = pathlib.Path(os.environ["LOCAL_GATE_FACE_CACHE_FILE"])
    with np.load(cache_path, allow_pickle=False) as cache:
        cached_references = sum(meta.get("id") == student_id
                                for meta in json.loads(str(cache["meta_json"][0])))
    probe = np.full(128, 0.01, dtype=np.float32)
    matched = bool(engine.known_encodings_np is not None and
                   np.min(np.linalg.norm(engine.known_encodings_np - probe, axis=1)) < 0.40)
    same_vectors = bool(engine.known_encodings_np is not None and
                        engine.known_encodings_np.shape == (5, 128) and
                        all(np.array_equal(engine.known_encodings_np[i - 1],
                                           np.full(128, i / 100, dtype=np.float32))
                            for i in range(1, 6)))
    print(json.dumps({"memory_references": references,
                      "cache_references": cached_references,
                      "distance_match": matched,
                      "same_vectors": same_vectors}), file=original_stdout)


def main():
    values = development_config()
    configure_isolated_engine(values)
    sys.path.insert(0, str(STUDENTS_DIR))
    from student_face_embedding_store import (
        checked_vector, fetch_student_embedding_rows, replace_student_embeddings,
    )
    client = create_client(values["SUPABASE_URL"], values["SUPABASE_SERVICE_ROLE_KEY"])
    public_client = create_client(values["SUPABASE_URL"], values["SUPABASE_ANON_KEY"])
    student_id = str(uuid.uuid4())
    stud_id = f"1-{str(uuid.uuid4().int % 9000 + 1000)}"
    path = f"students/student_{stud_id}/registration_disposable"
    cache_path = pathlib.Path(os.environ["LOCAL_GATE_FACE_CACHE_FILE"])
    if cache_path.exists():
        raise RuntimeError("Isolated test cache already exists; refusing to replace it")
    created = False
    original_stdout = sys.stdout
    try:
        client.table("students").insert({
            "student_id": student_id, "stud_id": stud_id,
            "first_name": "Disposable", "last_name": "FaceFixture",
            "current_grade_level": "Grade 1", "facial_dataset_path": path,
        }).execute()
        created = True
        engine = load_engine(path)
        # Exercise the real Storage decoding loop: four usable images and one
        # unencodable image must produce exactly four sourced references.
        class FakeStorage:
            def from_(self, bucket):
                assert bucket == "facial_data"
                return self

            def download(self, remote_path):
                return png_bytes

        class FakeSupabase:
            storage = FakeStorage()

        ok, png = engine.cv2.imencode(".png", np.zeros((20, 20, 3), dtype=np.uint8))
        assert ok
        png_bytes = png.tobytes()
        original_client = engine.supabase
        generated = iter([np.full(128, i / 100, dtype=np.float32)
                          for i in range(1, 5)] + [None])
        def fake_face_encodings(_image):
            result = next(generated)
            return [] if result is None else [result]
        try:
            engine.supabase = FakeSupabase()
            with patch.object(engine.face_recognition, "face_encodings", fake_face_encodings):
                encodings, metadata, sourced = [], [], []
                assert engine.load_encodings_from_storage(
                    path, {"role": "student", "id": student_id},
                    encodings, metadata, sourced) == 4
                assert [item["image_slot"] for item in sourced] == [1, 2, 3, 4]
        finally:
            engine.supabase = original_client

        fingerprint = engine._person_fingerprint("student", student_id, path, source_images())
        for count in (3, 4, 5):
            samples = [{"image_slot": slot, "source_image_name": f"{slot}.png",
                        "embedding": np.full(128, slot / 100, dtype=np.float32)}
                       for slot in range(1, count + 1)]
            assert replace_student_embeddings(
                client, student_id, path, fingerprint, samples) == count
            assert len(fetch_student_embedding_rows(client).get(student_id, [])) == count
            summary = client.table("students").select(
                "face_embedding,face_embedding_fingerprint"
            ).eq("student_id", student_id).single().execute().data
            assert summary["face_embedding_fingerprint"] == fingerprint
            assert np.allclose(checked_vector(summary["face_embedding"]),
                               np.mean([sample["embedding"] for sample in samples], axis=0))

        try:
            client.rpc("replace_student_face_embedding_set", {
                "p_student_id": student_id, "p_dataset_path": path,
                "p_fingerprint": fingerprint,
                "p_samples": [{"image_slot": 1, "source_image_name": "1.png",
                               "embedding": "[" + ",".join(["0.01"] * 128) + "]"}] * 2,
            }).execute()
            raise AssertionError("Duplicate slot was accepted")
        except AssertionError:
            raise
        except Exception:
            pass
        assert len(fetch_student_embedding_rows(client).get(student_id, [])) == 5

        try:
            replace_student_embeddings(client, student_id, path, fingerprint, [])
            raise AssertionError("Zero samples were accepted")
        except ValueError:
            pass
        assert len(fetch_student_embedding_rows(client).get(student_id, [])) == 5

        try:
            public_client.table("student_face_embeddings").select("embedding_id").limit(1).execute()
            raise AssertionError("Public biometric read was allowed")
        except AssertionError:
            raise
        except Exception:
            pass

        # A fresh process exercises the engine's real cache-missing startup.
        child = subprocess.run(
            [sys.executable, __file__, "--restore-child", student_id, path],
            env=os.environ.copy(), text=True, capture_output=True, timeout=120,
        )
        if child.returncode:
            raise RuntimeError(f"Isolated engine restart failed ({child.returncode})")
        restored = json.loads(child.stdout.strip().splitlines()[-1])
        assert restored == {"memory_references": 5, "cache_references": 5,
                            "distance_match": True, "same_vectors": True}

        # A stale NPZ must yield to a current database set without re-encoding
        # the same Storage images or reverting a newer registration.
        changed_images = source_images()
        changed_images[0]["updated_at"] = "2026-10-08T01:00:00Z"
        engine._list_face_images_for_folder = lambda folder: changed_images if folder == path else []
        database_fingerprint = engine._person_fingerprint(
            "student", student_id, path, changed_images)
        database_samples = [
            {"image_slot": slot, "source_image_name": f"{slot}.png",
             "embedding": np.full(128, slot / 100 + 0.0005, dtype=np.float32)}
            for slot in range(1, 5)
        ]
        assert replace_student_embeddings(
            client, student_id, path, database_fingerprint, database_samples) == 4
        engine.load_encodings_from_storage = lambda *args: (_ for _ in ()).throw(
            AssertionError("Matching database set must not be re-encoded"))
        engine.load_all_faces(force_rebuild=False)
        assert sum(meta.get("id") == student_id for meta in engine.known_meta) == 4
        assert len(fetch_student_embedding_rows(client).get(student_id, [])) == 4
        with np.load(cache_path, allow_pickle=False) as cache:
            assert sum(meta.get("id") == student_id
                       for meta in json.loads(str(cache["meta_json"][0]))) == 4

        # A genuinely changed Storage fingerprint must replace the old set,
        # not append to it or keep the now-stale database references.
        changed_images[0]["updated_at"] = "2026-10-08T01:15:00Z"
        def fake_encode(folder, meta, encodings, metadata, samples=None):
            for slot in range(1, 5):
                vector = np.full(128, slot / 100 + 0.001, dtype=np.float32)
                encodings.append(vector)
                metadata.append(meta)
                if samples is not None:
                    samples.append({"image_slot": slot, "source_image_name": f"{slot}.png",
                                    "embedding": vector})
            return 4
        engine.load_encodings_from_storage = fake_encode
        engine.load_all_faces(force_rebuild=False)
        rows = fetch_student_embedding_rows(client).get(student_id, [])
        assert len(rows) == 4
        assert all(row["dataset_fingerprint"] != database_fingerprint for row in rows)
        assert sum(meta.get("id") == student_id for meta in engine.known_meta) == 4

        # A failed database write must not activate a candidate set that is
        # absent from Supabase or overwrite the previous local cache.
        persisted_fingerprint = rows[0]["dataset_fingerprint"]
        changed_images[0]["updated_at"] = "2026-10-08T01:30:00Z"
        original_replace = engine.replace_student_embeddings
        try:
            engine.replace_student_embeddings = lambda *args: (_ for _ in ()).throw(
                RuntimeError("simulated persistence failure"))
            engine.load_all_faces(force_rebuild=False)
        finally:
            engine.replace_student_embeddings = original_replace
        rows = fetch_student_embedding_rows(client).get(student_id, [])
        assert len(rows) == 4 and rows[0]["dataset_fingerprint"] == persisted_fingerprint
        assert sum(meta.get("id") == student_id for meta in engine.known_meta) == 4

        # A later zero-encoding attempt must leave the four-row set intact.
        changed_images[0]["updated_at"] = "2026-10-08T02:00:00Z"
        engine.load_encodings_from_storage = lambda *args: 0
        engine.load_all_faces(force_rebuild=False)
        assert len(fetch_student_embedding_rows(client).get(student_id, [])) == 4
        assert sum(meta.get("id") == student_id for meta in engine.known_meta) == 4
        # Legacy compatibility: without individual rows or an NPZ, retain the
        # existing database average until Storage can be encoded again.
        client.table("student_face_embeddings").delete().eq("student_id", student_id).execute()
        if cache_path.exists():
            cache_path.unlink()
        engine.load_all_faces(force_rebuild=False)
        assert sum(meta.get("id") == student_id for meta in engine.known_meta) == 1
        print("Development checks passed: 3/4/5 rows, atomic rollback, public denial, "
              "five-reference cache restore, stale-cache database restore, "
              "changed-fingerprint replacement, "
              "write-failure preservation, zero preservation, legacy average fallback.",
              file=original_stdout)
    finally:
        if created:
            client.table("students").delete().eq("student_id", student_id).execute()
        for suffix in ("", ".tmp.npz"):
            candidate = pathlib.Path(str(cache_path) + suffix)
            if candidate.exists():
                candidate.unlink()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--restore-child":
        child_restore(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 1:
        main()
    else:
        raise SystemExit("Unexpected arguments")
