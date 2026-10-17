"""Deterministic tests for the per-person, per-event success timer."""

import importlib.util
import pathlib
import unittest


SOURCE = pathlib.Path(__file__).resolve().parents[2] / "TimeInAndTimeOutMonitoring" / "students" / "event_attendance_cooldown.py"
spec = importlib.util.spec_from_file_location("event_attendance_cooldown", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EventAttendanceCooldownTests(unittest.TestCase):
    def test_success_only_timer_is_per_person_role_and_event(self):
        clock = [0.0]
        recent = module.RecentEventAttendance(lambda: clock[0])
        self.assertEqual(recent.remaining("event-a", "student", "student-a", 5), 0)
        recent.mark_success("event-a", "student", "student-a")
        self.assertEqual(recent.remaining("event-a", "student", "student-a", 5), 5)
        self.assertEqual(recent.remaining("event-a", "student", "student-b", 5), 0)
        self.assertEqual(recent.remaining("event-b", "student", "student-a", 5), 0)
        self.assertEqual(recent.remaining("event-a", "employee", "student-a", 5), 0)
        recent.mark_success("event-a", "employee", "student-a")
        self.assertEqual(recent.remaining("event-a", "employee", "student-a", 5), 5)
        clock[0] = 4.999
        self.assertGreater(recent.remaining("event-a", "student", "student-a", 5), 0)
        clock[0] = 5
        self.assertEqual(recent.remaining("event-a", "student", "student-a", 5), 0)

    def test_setting_change_uses_latest_value_and_old_entries_expire(self):
        clock = [0.0]
        recent = module.RecentEventAttendance(lambda: clock[0])
        recent.mark_success("event", "student", "student")
        clock[0] = 6
        self.assertEqual(recent.remaining("event", "student", "student", 5), 0)
        self.assertEqual(recent.remaining("event", "student", "student", 20), 14)
        clock[0] = 301
        self.assertEqual(recent.remaining("event", "student", "student", 300), 0)
        self.assertEqual(recent.last_success, {})


if __name__ == "__main__":
    unittest.main()
