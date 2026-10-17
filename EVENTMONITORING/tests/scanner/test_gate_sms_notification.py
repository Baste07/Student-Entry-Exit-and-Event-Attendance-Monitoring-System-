"""No-network tests for the QR/ID gate SMS claim and protected route."""

import ast
import datetime
import pathlib
import sys
import unittest
from unittest.mock import patch

from flask import Flask, jsonify, request

STUDENTS = pathlib.Path(__file__).resolve().parents[2] / "TimeInAndTimeOutMonitoring" / "students"
sys.path.insert(0, str(STUDENTS))
from gate_sms_notification import notify_gate_sms  # noqa: E402
from local_admin_auth import require_admin_aal2  # noqa: E402
import local_admin_auth  # noqa: E402

STUDENT_A = "123e4567-e89b-42d3-a456-426614174000"
STUDENT_B = "123e4567-e89b-42d3-a456-426614174001"
LOG_A = "a23e4567-e89b-42d3-a456-426614174000"
LOG_B = "a23e4567-e89b-42d3-a456-426614174001"
TIME = "2026-10-13T17:00:00Z"


class UniqueViolation(Exception):
    code = "23505"


class Query:
    def __init__(self, client, table):
        self.client, self.table = client, table
        self.mode, self.payload, self.filters = "select", None, []

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, _count):
        return self

    def insert(self, payload):
        self.mode, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.mode, self.payload = "update", payload
        return self

    def execute(self):
        if self.mode == "insert":
            key = self.payload["entry_exit_log_id"]
            if key in self.client.notifications:
                raise UniqueViolation()
            self.client.notifications[key] = dict(self.payload)
            return type("Result", (), {"data": [self.payload]})()
        if self.mode == "update":
            key = dict(self.filters)["entry_exit_log_id"]
            self.client.notifications[key].update(self.payload)
            return type("Result", (), {"data": [self.client.notifications[key]]})()
        rows = self.client.tables[self.table]
        if isinstance(rows, dict):
            rows = list(rows.values())
        return type("Result", (), {"data": [row for row in rows if all(
            row.get(column) == value for column, value in self.filters)]})()


class FakeClient:
    def __init__(self):
        self.notifications = {}
        self.tables = {
            "entry_exit_logs": {
                LOG_A: {"id": LOG_A, "student_id": STUDENT_A, "employee_id": None,
                        "log_type": "entry", "scan_method": "qr", "log_timestamp": TIME},
                LOG_B: {"id": LOG_B, "student_id": STUDENT_B, "employee_id": None,
                        "log_type": "exit", "scan_method": "manual", "log_timestamp": TIME},
            },
            "students": {
                STUDENT_A: {"student_id": STUDENT_A, "first_name": "Student", "last_name": "A"},
                STUDENT_B: {"student_id": STUDENT_B, "first_name": "Student", "last_name": "B"},
            },
            "gate_sms_notifications": self.notifications,
        }

    def table(self, name):
        return Query(self, name)


class Settings:
    def __init__(self, master=True, gate=True, fresh=True):
        self.master, self.gate, self.is_fresh = master, gate, fresh

    def fresh(self, scope):
        return self.is_fresh

    def effective_sms(self, scope):
        return self.master and self.gate


class GateSmsTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeClient()
        self.sent = []

    def notify(self, log_id=LOG_A, settings=None, result=None):
        return notify_gate_sms(
            self.db, settings or Settings(), log_id,
            lambda _timestamp: "01:00 AM on October 14, 2026",
            provider_send=lambda phone, message: self._send(phone, message, result),
            guardian_lookup=lambda _db, _student: {"phone_number": "09000000000"},
        )

    def _send(self, phone, message, result):
        self.sent.append((phone, message))
        return result or {"success": True, "provider_status": 200,
                          "provider_message_id": "provider-test-id"}

    def test_entry_and_exit_use_saved_rows_and_shared_wording(self):
        for log_id, phrase in ((LOG_A, "entered the school"), (LOG_B, "exited the school")):
            response, code = self.notify(log_id)
            self.assertEqual((code, response["status"]), (200, "accepted_queued"))
            self.assertIn(phrase, self.sent[-1][1])
            self.assertIn("01:00 AM on October 14, 2026", self.sent[-1][1])
            self.assertEqual(self.db.notifications[log_id]["status"], "accepted")
            self.assertEqual(self.db.notifications[log_id]["attempt_count"], 1)
        self.assertEqual(len(self.sent), 2)

    def test_duplicate_and_new_engine_instance_do_not_resend(self):
        self.notify()
        again, code = self.notify()  # Only database state survives an engine restart.
        self.assertEqual((code, again["status"]), (200, "already_processed"))
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.db.notifications), 1)

    def test_other_student_is_independent(self):
        self.notify(LOG_A)
        self.notify(LOG_B)
        self.assertEqual(len(self.sent), 2)

    def test_disabled_or_stale_settings_never_call_provider(self):
        for settings in (Settings(master=False), Settings(gate=False), Settings(fresh=False)):
            self.db = FakeClient()
            response, _ = self.notify(settings=settings)
            self.assertEqual(response["status"], "suppressed")
            self.assertEqual(self.db.notifications[LOG_A]["status"], "suppressed")
        self.assertEqual(self.sent, [])

    def test_employee_face_and_invalid_rows_are_ineligible(self):
        for changes in ({"student_id": None, "employee_id": "employee"},
                        {"scan_method": "face"}, {"log_type": "other"}):
            self.db = FakeClient()
            self.db.tables["entry_exit_logs"][LOG_A].update(changes)
            response, code = self.notify()
            self.assertEqual((code, response["status"]), (422, "ineligible_log"))
            self.assertFalse(self.db.notifications)
        self.assertEqual(self.sent, [])

    def test_missing_student_or_log_does_not_claim(self):
        del self.db.tables["students"][STUDENT_A]
        self.assertEqual(self.notify()[1], 404)
        self.assertEqual(self.notify("b23e4567-e89b-42d3-a456-426614174000")[1], 404)
        self.assertEqual(self.notify("not-a-uuid")[1], 400)
        self.assertFalse(self.db.notifications)

    def test_provider_rejection_and_timeout_preserve_notification_claim(self):
        rejected = {"success": False, "request_attempted": True,
                    "failure_reason": "PROVIDER_HTTP_ERROR"}
        response, _ = self.notify(result=rejected)
        self.assertEqual(response["status"], "notification_failed")
        self.assertEqual(self.db.notifications[LOG_A]["status"], "failed")
        self.assertEqual(self.notify()[0]["status"], "already_processed")
        self.assertEqual(len(self.sent), 1)
        self.db = FakeClient()
        timeout = {"success": False, "request_attempted": True,
                   "failure_reason": "TIMEOUT"}
        response, _ = self.notify(result=timeout)
        self.assertEqual(response["status"], "notification_uncertain")
        self.assertEqual(self.db.notifications[LOG_A]["status"], "uncertain")

    def test_missing_guardian_phone_records_failure_without_provider(self):
        result, _ = notify_gate_sms(
            self.db, Settings(), LOG_A, lambda _: "Manila time",
            provider_send=lambda *_: self.fail("Provider must not be called"),
            guardian_lookup=lambda *_: {"phone_number": None},
        )
        self.assertEqual(result["status"], "notification_failed")
        self.assertEqual(self.db.notifications[LOG_A]["last_error"], "GUARDIAN_PHONE_NOT_FOUND")

    def test_route_requires_aal2_and_accepts_only_saved_log_id(self):
        source = (STUDENTS / "flask_attendance.py").read_text(encoding="utf-8")
        node = next(node for node in ast.parse(source).body
                    if isinstance(node, ast.FunctionDef) and node.name == "gate_sms_notify")
        app = Flask(__name__)
        calls = []
        namespace = {"app": app, "require_admin_aal2": require_admin_aal2,
                     "request": request, "jsonify": jsonify, "supabase": self.db,
                     "runtime_settings": Settings(), "_attendance_timestamp_label": str,
                     "notify_gate_sms": lambda *_: (calls.append(1) or {"success": True}, 200)}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "gate_sms_route", "exec"), namespace)
        client = app.test_client()
        body = {"entry_exit_log_id": LOG_A}
        with patch.object(local_admin_auth, "active_admin_aal2",
                          side_effect=lambda header: header == "Bearer aal2"):
            for header in ({}, {"Authorization": "Bearer aal1"}):
                response = client.post("/gate_sms_notify", json=body, headers=header)
                self.assertEqual(response.status_code, 403)
            self.assertEqual(calls, [])
            response = client.post("/gate_sms_notify", json=body,
                                   headers={"Authorization": "Bearer aal2"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(calls, [1])
            response = client.post("/gate_sms_notify", json={**body, "phone": "forged"},
                                   headers={"Authorization": "Bearer aal2"})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(calls, [1])


if __name__ == "__main__":
    unittest.main()
