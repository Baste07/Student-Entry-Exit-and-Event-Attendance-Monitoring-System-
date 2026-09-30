import importlib.util
import pathlib
import unittest


SOURCE = pathlib.Path(__file__).resolve().parents[2] / "TimeInAndTimeOutMonitoring" / "students" / "runtime_settings.py"
spec = importlib.util.spec_from_file_location("runtime_settings", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RuntimeSettings = module.RuntimeSettings


class Query:
    def __init__(self, rows):
        self.rows = rows

    def select(self, _columns):
        return self

    def execute(self):
        if isinstance(self.rows, Exception):
            raise self.rows
        return type("Response", (), {"data": self.rows})()


class Client:
    def __init__(self):
        self.tables = {
            "system_settings": [], "gate_settings": [], "event_settings": []
        }
        self.calls = 0

    def table(self, name):
        self.calls += 1
        return Query(self.tables[name])


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.settings = RuntimeSettings(self.client)
        self.settings.refresh()

    def set(self, table, **values):
        self.client.tables[table] = [{"key": key, "value": str(value).lower()} for key, value in values.items()]
        self.settings.refresh()

    def test_all_master_and_module_sms_combinations(self):
        for master in (True, False):
            for gate in (True, False):
                for event in (True, False):
                    self.client.tables["system_settings"] = [{"key": "sms_enabled", "value": str(master).lower()}]
                    self.client.tables["gate_settings"] = [{"key": "sms_enabled", "value": str(gate).lower()}]
                    self.client.tables["event_settings"] = [{"key": "sms_enabled", "value": str(event).lower()}]
                    self.settings.refresh()
                    self.assertEqual(self.settings.effective_sms("gate"), master and gate)
                    self.assertEqual(self.settings.effective_sms("event"), master and event)

    def test_master_off_keeps_module_preferences(self):
        self.set("system_settings", sms_enabled=False)
        self.assertEqual(self.settings.value("gate", "sms_enabled"), "true")
        self.assertEqual(self.settings.value("event", "sms_enabled"), "true")
        self.assertFalse(self.settings.effective_sms("gate"))
        self.set("system_settings", sms_enabled=True)
        self.assertTrue(self.settings.effective_sms("gate"))
        self.assertTrue(self.settings.effective_sms("event"))

    def test_unavailable_snapshot_blocks_sms_and_restores_anti_spoof(self):
        self.set("system_settings", anti_spoof_enabled=False)
        self.assertFalse(self.settings.anti_spoof_enabled())
        self.settings.loaded_at["system"] = 0
        self.assertFalse(self.settings.effective_sms("gate"))
        self.assertTrue(self.settings.anti_spoof_enabled())

    def test_refresh_failure_does_not_query_from_camera_reads(self):
        self.client.tables["event_settings"] = RuntimeError("network down")
        self.settings.refresh()
        before = self.client.calls
        for _ in range(100):
            self.settings.event_grace_minutes()
            self.settings.anti_spoof_enabled()
            self.settings.effective_sms("event")
        self.assertEqual(self.client.calls, before)

    def test_missing_module_tables_keep_legacy_sms_until_migration(self):
        self.client.tables["gate_settings"] = RuntimeError("PGRST205 table is missing")
        self.client.tables["event_settings"] = RuntimeError("PGRST205 table is missing")
        self.settings.refresh()
        self.assertTrue(self.settings.effective_sms("gate"))
        self.assertTrue(self.settings.effective_sms("event"))
        self.set("system_settings", sms_enabled=False)
        self.assertFalse(self.settings.effective_sms("gate"))
        self.assertFalse(self.settings.effective_sms("event"))

    def test_gate_hours_and_grace_validate_bounds(self):
        self.assertEqual(self.settings.gate_cooldown_seconds(), 5)
        self.set("gate_settings", enforceGateHours=True, gateOpen="06:00", gateClose="18:00", lateThreshold="07:30")
        self.assertFalse(self.settings.gate_accepts_scans("05:59"))
        self.assertTrue(self.settings.gate_accepts_scans("06:00"))
        self.assertFalse(self.settings.gate_accepts_scans("18:00"))
        self.assertFalse(self.settings.gate_is_late("07:29"))
        self.assertTrue(self.settings.gate_is_late("07:30"))
        self.set("gate_settings", cooldown=12)
        self.assertEqual(self.settings.gate_cooldown_seconds(), 12)
        self.set("event_settings", late_grace_minutes=20)
        self.assertEqual(self.settings.event_grace_minutes(), 20)
        self.set("event_settings", late_grace_minutes=300)
        self.assertEqual(self.settings.event_grace_minutes(), 15)


if __name__ == "__main__":
    unittest.main()
