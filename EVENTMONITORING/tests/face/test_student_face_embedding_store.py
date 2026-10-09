"""No real student images, credentials, or face vectors are printed by these tests."""

import importlib.util
import pathlib
import unittest
from types import SimpleNamespace

import numpy as np


HELPER = (pathlib.Path(__file__).resolve().parents[2] /
          "TimeInAndTimeOutMonitoring" / "students" /
          "student_face_embedding_store.py")
spec = importlib.util.spec_from_file_location("student_face_embedding_store", HELPER)
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class FakeRpc:
    def __init__(self, calls, name, payload):
        self.calls, self.name, self.payload = calls, name, payload

    def execute(self):
        self.calls.append((self.name, self.payload))
        return SimpleNamespace(data=len(self.payload["p_samples"]))


class FakeClient:
    def __init__(self):
        self.calls = []

    def rpc(self, name, payload):
        return FakeRpc(self.calls, name, payload)


def sample(slot):
    return {"image_slot": slot, "source_image_name": f"{slot}.png",
            "embedding": np.full(128, slot / 100, dtype=np.float32)}


class StudentFaceEmbeddingStoreTests(unittest.TestCase):
    def test_partial_reregistration_uses_a_fresh_image_folder(self):
        first = store.new_student_face_folder("1-0001")
        second = store.new_student_face_folder("1-0001")
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("students/student_1-0001/registration_"))
        self.assertTrue(second.startswith("students/student_1-0001/registration_"))

    def test_three_four_and_five_real_samples_are_sent(self):
        for count in (3, 4, 5):
            with self.subTest(count=count):
                client = FakeClient()
                self.assertEqual(store.replace_student_embeddings(
                    client, "test-uuid", "students/test/batch", "a" * 64,
                    [sample(i) for i in range(1, count + 1)]), count)
                self.assertEqual(len(client.calls[0][1]["p_samples"]), count)
                self.assertEqual(client.calls[0][0],
                                 "replace_student_face_embedding_set")

    def test_zero_or_duplicate_samples_never_call_the_database(self):
        client = FakeClient()
        for samples in ([], [sample(1), sample(1)],
                        [dict(sample(1), embedding=np.zeros(127))]):
            with self.assertRaises(ValueError):
                store.replace_student_embeddings(
                    client, "test-uuid", "students/test/batch", "a" * 64,
                    samples)
        self.assertEqual(client.calls, [])

    def test_fingerprint_and_dimensions_gate_restore(self):
        rows = [{"image_slot": i, "source_image_name": f"{i}.png",
                 "dataset_fingerprint": "a" * 64,
                 "embedding": store.vector_literal(sample(i)["embedding"])}
                for i in range(1, 6)]
        self.assertEqual(len(store.verified_student_embeddings(rows, "a" * 64)), 5)
        self.assertIsNone(store.verified_student_embeddings(rows, "b" * 64))
        rows[2]["embedding"] = "[0,0]"
        self.assertIsNone(store.verified_student_embeddings(rows, "a" * 64))

    def test_nonfinite_vector_is_rejected(self):
        vector = np.zeros(128)
        vector[0] = np.nan
        self.assertIsNone(store.checked_vector(vector))

    def test_vector_serialization_preserves_float32_components(self):
        original = np.linspace(-0.27, 0.31, 128, dtype=np.float32)
        self.assertTrue(np.array_equal(
            original, store.checked_vector(store.vector_literal(original))))


if __name__ == "__main__":
    unittest.main()
