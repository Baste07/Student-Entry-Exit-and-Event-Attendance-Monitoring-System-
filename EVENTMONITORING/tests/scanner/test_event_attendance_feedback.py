"""Exercise Event Attendance decisions without importing the live camera or database client."""

import ast
import datetime
import json
import pathlib
import unittest
from types import SimpleNamespace


ENGINE = (pathlib.Path(__file__).resolve().parents[2] /
          "TimeInAndTimeOutMonitoring" / "students" / "flask_attendance.py")
TREE = ast.parse(ENGINE.read_text(encoding="utf-8"))
RECORD_FUNCTION = next(node for node in TREE.body
                       if isinstance(node, ast.FunctionDef) and node.name == "_record_event_attendance")
SELECT_FUNCTION = next(node for node in TREE.body
                       if isinstance(node, ast.FunctionDef) and node.name == "_select_relevant_event")


class FixedDatetime(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        instant = datetime.datetime(2026, 10, 11, 1, 0, tzinfo=datetime.timezone.utc)
        return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)


FIXED_DATETIME_MODULE = SimpleNamespace(datetime=FixedDatetime, date=datetime.date,
    time=datetime.time, timedelta=datetime.timedelta, timezone=datetime.timezone)


class FakeQuery:
    def __init__(self, database, table):
        self.database, self.table = database, table
        self.filters = []
        self.operation = "select"
        self.values = None

    def select(self, *_args):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def in_(self, column, values):
        self.filters.append((column, set(values)))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def insert(self, values):
        self.operation, self.values = "insert", values
        return self

    def update(self, values):
        self.operation, self.values = "update", values
        return self

    def execute(self):
        rows = self.database.rows[self.table]
        if self.operation == "insert":
            rows.append(dict(self.values))
            self.database.writes.append(("insert", self.table))
            return SimpleNamespace(data=[self.values])
        matched = [row for row in rows if all(
            row.get(column) in value if isinstance(value, set) else row.get(column) == value
            for column, value in self.filters)]
        if self.operation == "update":
            for row in matched:
                row.update(self.values)
            self.database.writes.append(("update", self.table))
        return SimpleNamespace(data=matched)


class FakeDatabase:
    def __init__(self, events, attendance, registered=True):
        self.rows = {
            "event_participants": [{"student_id": "student", "event_id": row["event_id"]}
                                   for row in events] if registered else [],
            "events": list(events),
            "event_attendance": list(attendance),
        }
        self.writes = []

    def table(self, name):
        return FakeQuery(self, name)


def exercise_events(events, attendance=None, late_minutes=0, registered=True):
    database = FakeDatabase(events, attendance or [], registered)
    events = []
    namespace = {
        "supabase": database,
        "datetime": FIXED_DATETIME_MODULE,
        "_event_late_minutes": lambda *_args: late_minutes,
        "_push": events.append,
        "thread_pool": SimpleNamespace(submit=lambda *_args, **_kwargs: None),
        "_send_attendance_email": lambda *_args, **_kwargs: None,
        "_send_attendance_sms": lambda *_args, **_kwargs: None,
    }
    selected = ast.Module(body=[SELECT_FUNCTION, RECORD_FUNCTION], type_ignores=[])
    exec(compile(selected, str(ENGINE), "exec"), namespace)
    namespace["_record_event_attendance"]("student", {
        "name": "Test Student", "stud_id": "1-0001", "grade_level": "Grade 1",
        "section_name": "MABAIT",
    })
    return database, events[-1]


def exercise(status, attendance=None, late_minutes=0, registered=True):
    event = {"event_id": "event", "event_name": "School Program", "status": status,
             "event_date": "2026-10-11", "time_start": "08:00:00",
             "time_end": "08:30:00" if status == "completed" else "10:00:00"}
    return exercise_events([event], [attendance] if attendance else [], late_minutes, registered)


class EventAttendanceFeedbackTests(unittest.TestCase):
    def test_face_selection_matches_shared_schedule_cases(self):
        fixtures = json.loads((pathlib.Path(__file__).with_name("event-selection-fixtures.json")).read_text())
        namespace = {"datetime": FIXED_DATETIME_MODULE}
        exec(compile(ast.Module(body=[SELECT_FUNCTION], type_ignores=[]), str(ENGINE), "exec"), namespace)
        now = datetime.datetime(2026, 10, 11, 1, 0, tzinfo=datetime.timezone.utc)
        for fixture in fixtures:
            with self.subTest(case=fixture["name"]):
                state, event = namespace["_select_relevant_event"](
                    fixture["events"], now, fixture.get("open_event_ids", []))
                self.assertEqual(state, fixture["state"])
                self.assertEqual(event["event_id"] if event else None, fixture["event_id"])

    def test_historical_completed_never_masks_active_or_upcoming_or_becomes_time_out(self):
        old = {"event_id": "old", "event_name": "Old Exhibit", "status": "completed",
               "event_date": "2026-10-01", "time_start": "08:00:00", "time_end": "10:00:00"}
        old_attendance = {"attendance_id": "old-row", "event_id": "old", "student_id": "student",
                          "time_in": "2026-10-01T00:00:00Z", "time_out": None}
        active = {"event_id": "active", "event_name": "Today", "status": "ongoing",
                  "event_date": "2026-10-11", "time_start": "08:00:00", "time_end": "10:00:00"}
        database, result = exercise_events([old, active], [old_attendance])
        self.assertEqual(result["type"], "time_in")
        self.assertEqual(database.rows["event_attendance"][-1]["event_id"], "active")
        self.assertIsNone(old_attendance["time_out"])

        future = {**active, "event_id": "future", "event_name": "Next Event",
                  "status": "upcoming", "time_start": "13:00:00", "time_end": "15:00:00"}
        database, result = exercise_events([old, future], [old_attendance])
        self.assertEqual(result["type"], "event_not_started")
        self.assertEqual(result["event_name"], "Next Event")
        self.assertEqual(database.writes, [])

        database, result = exercise_events([old], [old_attendance])
        self.assertEqual(result["type"], "no_active_event")
        self.assertEqual(database.writes, [])

    def test_pending_time_out_today_precedes_upcoming_then_upcoming_resumes(self):
        ended = {"event_id": "ended", "event_name": "Morning Event", "status": "completed",
                 "event_date": "2026-10-11", "time_start": "07:00:00", "time_end": "08:30:00"}
        future = {"event_id": "future", "event_name": "Afternoon Event", "status": "upcoming",
                  "event_date": "2026-10-11", "time_start": "13:00:00", "time_end": "15:00:00"}
        open_row = {"attendance_id": "morning-row", "event_id": "ended", "student_id": "student",
                    "time_in": "2026-10-10T23:00:00+00:00", "time_out": None}
        database, result = exercise_events([ended, future], [open_row])
        self.assertEqual(result["type"], "time_out")
        self.assertEqual(result["event_name"], "Morning Event")
        self.assertEqual(database.writes, [("update", "event_attendance")])
        self.assertIsNotNone(open_row["time_out"])

        database, result = exercise_events([ended, future], [open_row])
        self.assertEqual(result["type"], "event_not_started")
        self.assertEqual(result["event_name"], "Afternoon Event")
        self.assertEqual(database.writes, [])

    def test_on_time_and_late_time_in_keep_the_existing_saved_remarks(self):
        for late, expected_status, expected_remarks in (
                (0, "on-time", "On time"), (20, "late", "Late by 20 min")):
            with self.subTest(late_minutes=late):
                database, event = exercise("ongoing", late_minutes=late)
                self.assertEqual(database.writes, [("insert", "event_attendance")])
                self.assertEqual(database.rows["event_attendance"][0]["remarks"], expected_remarks)
                self.assertEqual(event["type"], "time_in")
                self.assertEqual(event["attendance_status"], expected_status)

    def test_early_time_out_is_distinct_from_completed_attendance(self):
        row = {"attendance_id": "attendance", "event_id": "event", "student_id": "student",
               "time_in": "2026-10-11T08:00:00+00:00", "time_out": None}
        database, event = exercise("ongoing", row)
        self.assertEqual(database.writes, [])
        self.assertEqual(event["type"], "time_out_unavailable")
        self.assertIn("not yet available", event["reason"])

        row["time_out"] = "2026-10-11T10:00:00+00:00"
        for status in ("ongoing", "completed"):
            with self.subTest(status=status):
                database, event = exercise(status, row.copy())
                self.assertEqual(database.writes, [])
                self.assertEqual(event["type"], "already_recorded")

    def test_no_valid_time_in_never_claims_time_out_is_merely_early(self):
        row = {"attendance_id": "attendance", "event_id": "event", "student_id": "student",
               "time_in": None, "time_out": None}
        database, event = exercise("ongoing", row)
        self.assertEqual(database.writes, [])
        self.assertEqual(event["type"], "error")

    def test_unregistered_student_does_not_create_attendance(self):
        database, event = exercise("ongoing", registered=False)
        self.assertEqual(database.writes, [])
        self.assertEqual(event["type"], "not_participant")

    def test_completed_event_allows_valid_time_out(self):
        row = {"attendance_id": "attendance", "event_id": "event", "student_id": "student",
               "time_in": "2026-10-11T08:00:00+00:00", "time_out": None}
        database, event = exercise("completed", row)
        self.assertEqual(database.writes, [("update", "event_attendance")])
        self.assertEqual(event["type"], "time_out")
        self.assertIsNotNone(database.rows["event_attendance"][0]["time_out"])


if __name__ == "__main__":
    unittest.main()
