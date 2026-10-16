"""Camera selection tests without importing the live Flask engine or opening a webcam."""

import ast
import os
import pathlib
import threading
import time
import unittest
from types import SimpleNamespace


ENGINE = pathlib.Path(__file__).resolve().parents[2] / "TimeInAndTimeOutMonitoring" / "students" / "flask_attendance.py"
TREE = ast.parse(ENGINE.read_text(encoding="utf-8"))
FUNCTIONS = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in {
    "_camera_candidates", "_open_attendance_camera", "_find_camera_index",
    "_ensure_attendance_camera_open", "_release_attendance_camera",
}]


class FakeCapture:
    def __init__(self, opened, readable):
        self.opened = opened
        self.readable = readable
        self.released = False

    def isOpened(self):
        return self.opened

    def read(self):
        return self.readable, object() if self.readable else None

    def set(self, *_args):
        return True

    def release(self):
        self.released = True


class AttendanceCameraSelectionTests(unittest.TestCase):
    def make_engine(self, cameras):
        attempts = []
        captures = []

        def video_capture(index, *_backend):
            attempts.append(index)
            opened, readable = cameras.get(index, (False, False))
            capture = FakeCapture(opened, readable)
            captures.append(capture)
            return capture

        cv2 = SimpleNamespace(VideoCapture=video_capture, CAP_DSHOW=700,
                              CAP_PROP_BUFFERSIZE=1, CAP_PROP_FRAME_WIDTH=2,
                              CAP_PROP_FRAME_HEIGHT=3, CAP_PROP_FPS=4)
        namespace = {
            "cv2": cv2, "os": SimpleNamespace(name="nt", getenv=lambda _key: None),
            "time": time, "camera": None, "_cam_index": None,
            "camera_runtime_lock": threading.Lock(), "frame_lock": threading.Lock(),
            "camera_retry_at": 0.0, "camera_failed_index": None,
            "camera_failed_until": 0.0, "latest_frame": None,
            "camera_status": {"available": None}, "CLI_CAMERA_INDEX": None,
            "ISOLATED_FACE_TEST": False, "_has_camera_owner": lambda: True,
        }
        exec(compile(ast.Module(body=FUNCTIONS, type_ignores=[]), str(ENGINE), "exec"), namespace)
        return namespace, attempts, captures

    def test_external_camera_wins_and_releases_when_stopped(self):
        engine, attempts, captures = self.make_engine({0: (True, True), 1: (True, True)})
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [1])
        self.assertEqual(engine["camera_status"]["type"], "likely external")
        self.assertFalse(captures[0].released)
        engine["_release_attendance_camera"]()
        self.assertTrue(captures[0].released)

    def test_unreadable_external_tries_next_candidate(self):
        engine, attempts, captures = self.make_engine({1: (True, False), 2: (True, True), 0: (True, True)})
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [1, 2])
        self.assertTrue(captures[0].released)
        self.assertEqual(engine["_cam_index"], 2)

    def test_unavailable_external_falls_back_to_local(self):
        engine, attempts, captures = self.make_engine({0: (True, True)})
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [1, 2, 3, 4, 0])
        self.assertTrue(all(cap.released for cap in captures[:-1]))
        self.assertEqual(engine["camera_status"]["type"], "local/default")

    def test_no_usable_camera_returns_clear_unavailable_state(self):
        engine, attempts, captures = self.make_engine({1: (True, False)})
        self.assertFalse(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [1, 2, 3, 4, 0])
        self.assertTrue(all(cap.released for cap in captures))
        self.assertFalse(engine["camera_status"]["available"])
        self.assertIn("Camera Required", engine["camera_status"]["message"])
        self.assertFalse(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(len(attempts), 5)  # Throttles retries instead of looping over devices.

    def test_failed_live_camera_is_skipped_for_next_fallback(self):
        engine, attempts, captures = self.make_engine({1: (True, True), 2: (True, True), 0: (True, True)})
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        engine["_release_attendance_camera"](failed=True)
        self.assertTrue(captures[0].released)
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [1, 2])
        self.assertEqual(engine["_cam_index"], 2)

    def test_index_zero_override_still_keeps_external_first(self):
        engine, attempts, _captures = self.make_engine({0: (True, True), 1: (True, True)})
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [1])
        self.assertEqual(engine["_camera_candidates"](cli_index=0), [1, 2, 3, 4, 0])

    def test_isolated_face_test_keeps_its_local_camera(self):
        engine, attempts, _captures = self.make_engine({0: (True, True), 2: (True, True)})
        engine["ISOLATED_FACE_TEST"] = True
        engine["CLI_CAMERA_INDEX"] = 2
        self.assertTrue(engine["_ensure_attendance_camera_open"]())
        self.assertEqual(attempts, [0])


if __name__ == "__main__":
    unittest.main()
