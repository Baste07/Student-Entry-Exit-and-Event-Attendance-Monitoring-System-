"""Offline checks that Event completion cannot stop or reroute the shared face engine."""

import ast
from pathlib import Path
import unittest


ENGINE = (Path(__file__).resolve().parents[2] /
          "TimeInAndTimeOutMonitoring/students/flask_attendance.py")


class FakePool:
    def __init__(self):
        self.tasks = []

    def submit(self, function, *args):
        self.tasks.append((function.__name__, args))


class AutomaticSessionLifecycleTests(unittest.TestCase):
    def test_recognition_routes_gate_and_event_modes_independently(self):
        source = ENGINE.read_text(encoding="utf-8")
        declaration = next(node for node in ast.parse(source).body
                           if isinstance(node, ast.FunctionDef)
                           and node.name == "_handle_recognition")
        isolated = compile(ast.Module(body=[declaration], type_ignores=[]),
                           str(ENGINE), "exec")
        pool = FakePool()
        pushed = []
        def gate(_meta):
            pass
        def event(_student_id, _meta):
            pass
        namespace = {
            "thread_pool": pool,
            "_push": pushed.append,
            "_record_gate_log": gate,
            "_record_event_attendance": event,
            "_get_scanner_mode": lambda: "entry_exit",
        }
        exec(isolated, namespace)
        meta = {"id": "student-a", "name": "Student A", "role": "student"}

        # A completed Event is irrelevant to the Entry/Exit scanner mode.
        namespace["_handle_recognition"](meta)
        self.assertEqual([task[0] for task in pool.tasks], ["gate"])
        self.assertEqual(pushed[-1]["type"], "recognized")

        pool.tasks.clear()
        namespace["_get_scanner_mode"] = lambda: "event_attendance"
        namespace["_handle_recognition"](meta)
        self.assertEqual([task[0] for task in pool.tasks], ["event"])
        self.assertEqual(pushed[-1]["type"], "recognized")
        self.assertNotIn("shutdown", ast.get_source_segment(source, declaration))


if __name__ == "__main__":
    unittest.main()
