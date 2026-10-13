"""Test the real Flask SMS formatting path without starting the camera or provider."""

import ast
import datetime
import importlib.util
import os
import pathlib
import unittest
from zoneinfo import ZoneInfo


STUDENTS = pathlib.Path(__file__).resolve().parents[2] / "TimeInAndTimeOutMonitoring" / "students"
ENGINE = STUDENTS / "flask_attendance.py"
tree = ast.parse(ENGINE.read_text(encoding="utf-8"))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {
    "_attendance_timestamp_label", "_send_attendance_sms",
}]

spec = importlib.util.spec_from_file_location("sms_notifications", STUDENTS / "sms_notifications.py")
sms_notifications = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sms_notifications)


class AttendanceSmsTimezoneTests(unittest.TestCase):
    def setUp(self):
        self.sent_messages = []
        self.namespace = {
            "datetime": datetime,
            "ZoneInfo": ZoneInfo,
            "os": os,
            "supabase": object(),
            "_sms_notifications_enabled": lambda _type: (True, None),
            "resolve_guardian_phone": lambda _client, _student: {"phone_number": "test-phone"},
            "generate_attendance_sms": sms_notifications.generate_attendance_sms,
            "send_sms": self.fake_send,
            "mask_phone_for_log": lambda _phone: "****",
            "_log_sms_status": lambda *_args, **_kwargs: None,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(ENGINE), "exec"), self.namespace)

    def fake_send(self, _phone, message):
        self.sent_messages.append(message)
        return {"success": True, "message": "queued"}

    def test_utc_timestamp_is_formatted_in_manila(self):
        label = self.namespace["_attendance_timestamp_label"]("2026-10-13T14:54:28Z")
        self.assertEqual(label, "10:54 PM on October 13, 2026")

    def test_utc_date_rolls_over_in_manila(self):
        label = self.namespace["_attendance_timestamp_label"]("2026-10-13T17:00:00Z")
        self.assertEqual(label, "01:00 AM on October 14, 2026")

    def test_explicit_manila_offset_keeps_same_instant(self):
        label = self.namespace["_attendance_timestamp_label"]("2026-10-13T22:54:28+08:00")
        self.assertEqual(label, "10:54 PM on October 13, 2026")

    def test_all_four_attendance_sms_paths_use_manila_date_and_time(self):
        examples = {
            "school_time_in": "Attendance Notification: Test Student entered the school at 01:00 AM on October 14, 2026.",
            "school_time_out": "Attendance Notification: Test Student exited the school at 01:00 AM on October 14, 2026.",
            "event_time_in": "Event Attendance: Test Student attended School Program at 01:00 AM on October 14, 2026.",
            "event_time_out": "Event Attendance: Test Student exited School Program at 01:00 AM on October 14, 2026.",
        }
        for notification_type, expected in examples.items():
            with self.subTest(notification_type=notification_type):
                self.sent_messages.clear()
                self.namespace["_send_attendance_sms"](
                    "test-student", notification_type, "2026-10-13T17:00:00Z",
                    {"name": "Test Student"}, event_name="School Program",
                )
                self.assertEqual(self.sent_messages, [expected])


if __name__ == "__main__":
    unittest.main()
