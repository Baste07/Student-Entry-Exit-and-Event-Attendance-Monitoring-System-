"""Short, per-participant/Event suppression after a successful attendance write."""

import threading
import time


class RecentEventAttendance:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.last_success = {}

    def remaining(self, event_id, role, person_id, seconds):
        key = (str(event_id), str(role), str(person_id))
        with self.lock:
            last = self.last_success.get(key)
            if last is None:
                return 0.0
            age = self.clock() - last
            if age >= 300:
                self.last_success.pop(key, None)
                return 0.0
            return max(0.0, float(seconds) - age)

    def mark_success(self, event_id, role, person_id):
        key = (str(event_id), str(role), str(person_id))
        now = self.clock()
        with self.lock:
            self.last_success[key] = now
            # 300 seconds is the largest permitted setting. Keep the map small
            # without a background cleanup thread or camera-loop database reads.
            if len(self.last_success) > 4096:
                self.last_success = {item: seen for item, seen in self.last_success.items()
                                     if now - seen < 300}
