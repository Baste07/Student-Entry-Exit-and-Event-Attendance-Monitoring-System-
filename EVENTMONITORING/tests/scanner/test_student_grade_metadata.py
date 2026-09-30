"""Check scanner display metadata without starting the camera/Flask threads."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).resolve().parents[2] / "TimeInAndTimeOutMonitoring" / "students" / "flask_attendance.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
fetch_node = next(node for node in tree.body
                  if isinstance(node, ast.FunctionDef)
                  and node.name == "_fetch_student_details")
fetch_module = ast.Module(body=[fetch_node], type_ignores=[])
ast.fix_missing_locations(fetch_module)


class Query:
    def __init__(self, rows):
        self.rows = rows

    def select(self, _columns):
        return self

    def in_(self, _column, _values):
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class Supabase:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        return Query(self.rows[name])


class StudentGradeMetadataTest(unittest.TestCase):
    def test_promoted_student_uses_current_grade_and_persistent_section(self):
        uuid = "8a01ad90-2364-44f8-a317-e2be64674a38"
        globals_for_test = {"supabase": Supabase({
            "students": [{"student_id": uuid, "stud_id": "2-0001",
                          "current_grade_level": "Grade 2", "section_id": "section-a",
                          "email": "student@example.invalid"}],
            "sections": [{"section_id": "section-a", "grade_level": "Grade 1",
                          "section_name": "Section A"}],
        })}
        exec(compile(fetch_module, str(SOURCE), "exec"), globals_for_test)
        details = globals_for_test["_fetch_student_details"]([uuid])[uuid]
        self.assertEqual(details["stud_id"], "2-0001")
        self.assertEqual(details["grade_level"], "Grade 2")
        self.assertEqual(details["section_name"], "Section A")


if __name__ == "__main__":
    unittest.main()
