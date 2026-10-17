"""One server-side SMS attempt per saved QR/ID gate log.

The unique entry_exit_log_id claim is stored before contacting iPROG. A crash
or uncertain provider response is left for deliberate review, never retried
automatically, because an automatic retry could deliver a second message.
"""

import datetime
import uuid

from sms_notifications import generate_attendance_sms, resolve_guardian_phone, send_sms


UNCERTAIN_FAILURES = {
    "TIMEOUT", "CONNECTION_ERROR", "REQUEST_ERROR",
    "MALFORMED_PROVIDER_RESPONSE", "MISSING_PROVIDER_MESSAGE_ID",
}


def _first(client, table, columns, column, value):
    response = (client.table(table).select(columns).eq(column, value).limit(1).execute())
    return (response.data or [None])[0]


def _set_state(client, log_id, **values):
    values["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    client.table("gate_sms_notifications").update(values).eq("entry_exit_log_id", log_id).execute()


def _duplicate_claim(error):
    return str(getattr(error, "code", "")) == "23505"


def notify_gate_sms(client, settings, raw_log_id, timestamp_label,
                    provider_send=send_sms, guardian_lookup=resolve_guardian_phone):
    """Return (public status, HTTP status); never return recipient or SMS text."""
    try:
        log_id = str(uuid.UUID(str(raw_log_id)))
    except (TypeError, ValueError, AttributeError):
        return {"success": False, "status": "invalid_log_id"}, 400

    try:
        log = _first(client, "entry_exit_logs",
                     "id,student_id,employee_id,log_type,scan_method,log_timestamp",
                     "id", log_id)
        if not log:
            return {"success": False, "status": "log_not_found"}, 404
        if (not log.get("student_id") or log.get("employee_id")
                or log.get("scan_method") not in ("qr", "manual")
                or log.get("log_type") not in ("entry", "exit")
                or not log.get("log_timestamp")):
            return {"success": False, "status": "ineligible_log"}, 422

        student_id = str(log["student_id"])
        student = _first(client, "students",
                         "student_id,first_name,middle_name,last_name",
                         "student_id", student_id)
        if not student:
            return {"success": False, "status": "student_not_found"}, 404

        try:
            client.table("gate_sms_notifications").insert({
                "entry_exit_log_id": log_id,
                "student_id": student_id,
                "status": "claimed",
                "attempt_count": 0,
            }).execute()
        except Exception as error:
            if not _duplicate_claim(error):
                raise
            existing = _first(client, "gate_sms_notifications", "status",
                              "entry_exit_log_id", log_id)
            return {"success": True, "status": "already_processed",
                    "notification_status": existing.get("status") if existing else "unknown"}, 200

        if (not settings.fresh("system") or not settings.fresh("gate")
                or not settings.effective_sms("gate")):
            _set_state(client, log_id, status="suppressed", last_error="SMS_DISABLED_OR_UNAVAILABLE")
            return {"success": True, "status": "suppressed"}, 200

        try:
            guardian = guardian_lookup(client, student_id)
        except Exception:
            _set_state(client, log_id, status="failed", last_error="GUARDIAN_LOOKUP_ERROR")
            return {"success": True, "status": "notification_failed"}, 200
        phone = guardian.get("phone_number")
        if not phone:
            _set_state(client, log_id, status="failed", last_error="GUARDIAN_PHONE_NOT_FOUND")
            return {"success": True, "status": "notification_failed"}, 200

        notification_type = ("school_time_in" if log["log_type"] == "entry"
                             else "school_time_out")
        name = " ".join(str(student.get(part) or "").strip()
                        for part in ("first_name", "middle_name", "last_name")).strip()
        message = generate_attendance_sms(
            notification_type, " ".join(name.split()),
            timestamp_label(log["log_timestamp"]),
        )

        # Persist the attempt before the network call. Never automatically
        # retry a claimed/sending/uncertain row after an engine restart.
        _set_state(client, log_id, status="sending", attempt_count=1)
        try:
            result = provider_send(phone, message)
        except Exception:
            result = {"success": False, "request_attempted": True,
                      "failure_reason": "PROVIDER_EXCEPTION"}

        failure = str(result.get("failure_reason") or "PROVIDER_ERROR")
        status = ("accepted" if result.get("success") else
                  "uncertain" if failure in UNCERTAIN_FAILURES or failure == "PROVIDER_EXCEPTION"
                  else "failed")
        _set_state(
            client, log_id, status=status,
            provider_status=str(result.get("provider_status") or "")[:100] or None,
            provider_message_id=str(result.get("provider_message_id") or result.get("message_id") or "")[:128] or None,
            last_error=None if status == "accepted" else failure[:100],
            accepted_at=(datetime.datetime.now(datetime.timezone.utc).isoformat()
                         if status == "accepted" else None),
        )
        return {"success": True, "status": "accepted_queued" if status == "accepted"
                else "notification_uncertain" if status == "uncertain"
                else "notification_failed"}, 200
    except Exception:
        # A write failure here cannot undo the already-saved gate attendance.
        # The unique claim, if present, still prevents an automatic resend.
        return {"success": False, "status": "notification_unavailable"}, 503
