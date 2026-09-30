"""Small, thread-safe settings snapshot for the shared attendance engine.

The camera worker only reads memory. One daemon refreshes the three tiny key/value
tables periodically; notification sends fail closed if the snapshot is unavailable.
"""

import threading
import time
import re


DEFAULTS = {
    "system": {"sms_enabled": "true", "anti_spoof_enabled": "true"},
    "gate": {"sms_enabled": "true", "gateOpen": "06:00", "gateClose": "18:00",
             "lateThreshold": "07:30", "autoExit": "true", "cooldown": "10",
             "enforceGateHours": "false"},
    "event": {"sms_enabled": "true", "late_grace_minutes": "15"},
}
TABLES = {"system": "system_settings", "gate": "gate_settings", "event": "event_settings"}


def clock_minutes(value, fallback):
    text = str(value)
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", text):
        text = fallback
    hours, minutes = map(int, text.split(":"))
    return hours * 60 + minutes


def missing_table(error):
    code = str(getattr(error, "code", ""))
    message = str(error)
    return code in ("42P01", "PGRST205") or "PGRST205" in message or "42P01" in message


class RuntimeSettings:
    def __init__(self, client, refresh_seconds=15, max_age_seconds=60):
        self.client = client
        self.refresh_seconds = refresh_seconds
        self.max_age_seconds = max_age_seconds
        self.lock = threading.Lock()
        self.rows = {scope: dict(values) for scope, values in DEFAULTS.items()}
        self.stored_keys = {scope: set() for scope in TABLES}
        self.loaded_at = {scope: 0.0 for scope in TABLES}
        self.thread = None

    def refresh(self):
        for scope, table in TABLES.items():
            try:
                response = self.client.table(table).select("key,value").execute()
                rows = {str(row["key"]): str(row["value"]) for row in (response.data or [])}
                with self.lock:
                    self.rows[scope] = {**DEFAULTS[scope], **rows}
                    self.stored_keys[scope] = set(rows)
                    self.loaded_at[scope] = time.monotonic()
            except Exception as exc:
                if scope in ("gate", "event") and missing_table(exc):
                    # Before the migration, retain the old notification behavior.
                    # A real network or permission failure still fails SMS closed.
                    with self.lock:
                        self.rows[scope] = dict(DEFAULTS[scope])
                        self.stored_keys[scope] = set()
                        self.loaded_at[scope] = time.monotonic()
                    print(f"[settings] {table} not deployed; using legacy defaults")
                else:
                    print(f"[settings] Cannot refresh {table}: {exc}")

    def start(self):
        if self.thread is not None:
            return

        def loop():
            while True:
                self.refresh()
                time.sleep(self.refresh_seconds)

        self.thread = threading.Thread(target=loop, name="settings-refresh", daemon=True)
        self.thread.start()

    def value(self, scope, key, default=None):
        with self.lock:
            return self.rows.get(scope, {}).get(key, default)

    def fresh(self, scope):
        with self.lock:
            loaded = self.loaded_at.get(scope, 0.0)
        return loaded > 0 and time.monotonic() - loaded <= self.max_age_seconds

    def enabled(self, scope, key, default=True):
        value = self.value(scope, key, "true" if default else "false")
        return str(value).strip().lower() == "true"

    def effective_sms(self, scope):
        if scope not in ("gate", "event"):
            return False
        return (self.fresh("system") and self.fresh(scope)
                and self.enabled("system", "sms_enabled")
                and self.enabled(scope, "sms_enabled"))

    def anti_spoof_enabled(self, machine_enabled=True):
        # If the database is unavailable, retain the machine's existing policy.
        return machine_enabled and (not self.fresh("system")
                                    or str(self.value("system", "anti_spoof_enabled", "true")).lower() != "false")

    def event_grace_minutes(self):
        try:
            value = int(self.value("event", "late_grace_minutes", "15"))
            return value if 0 <= value <= 99 else 15
        except (TypeError, ValueError):
            return 15

    def gate_cooldown_seconds(self):
        with self.lock:
            configured = "cooldown" in self.stored_keys["gate"]
        if not configured:
            return 5  # Existing facial-recognition default; QR/UI keeps its 10-second default.
        try:
            value = int(self.value("gate", "cooldown", "10"))
            return value if 1 <= value <= 300 else 10
        except (TypeError, ValueError):
            return 10

    def gate_accepts_scans(self, clock):
        if not self.enabled("gate", "enforceGateHours", False):
            return True
        opening = clock_minutes(self.value("gate", "gateOpen"), "06:00")
        closing = clock_minutes(self.value("gate", "gateClose"), "18:00")
        return opening <= clock_minutes(clock, "00:00") < closing

    def gate_is_late(self, clock):
        return clock_minutes(clock, "00:00") >= clock_minutes(self.value("gate", "lateThreshold"), "07:30")
