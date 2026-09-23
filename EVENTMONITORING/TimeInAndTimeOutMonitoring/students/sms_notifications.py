"""Backend-only iPROG SMS helpers.

The provider token is read from the attendance service environment and is never
included in logs or returned to callers.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

DEFAULT_API_URL = ""
DEFAULT_SMS_PROVIDER = 0
SMS_PROVIDER_VALUES = {0, 1, 2}
SMS_USER_AGENT = "CAPSTONEFINAL-Attendance/1.0"


def mask_phone(phone_number: str) -> str:
    digits = re.sub(r"\D", "", str(phone_number or ""))
    if len(digits) < 4:
        return "****"
    return f"{'*' * max(0, len(digits) - 4)}{digits[-4:]}"


def normalize_philippine_mobile(phone_number: str) -> str | None:
    """Return the iPROG-compatible 63XXXXXXXXXX form for a PH mobile number."""
    raw = str(phone_number or "").strip()
    digits = re.sub(r"\D", "", raw)

    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("63"):
        normalized = digits
    elif digits.startswith("09") and len(digits) == 11:
        normalized = "63" + digits[1:]
    elif digits.startswith("9") and len(digits) == 10:
        normalized = "63" + digits
    else:
        return None

    if not re.fullmatch(r"639\d{9}", normalized):
        return None
    return normalized


def generate_attendance_sms(
    notification_type: str,
    student_name: str,
    timestamp: str,
    event_name: str | None = None,
) -> str:
    """Generate the requested short message without contacting iPROG."""
    name = str(student_name or "Student").strip() or "Student"
    time_value = str(timestamp or "").strip() or "the recorded time"

    if notification_type == "school_time_in":
        return f"Attendance Notification: {name} entered the school at {time_value}."
    if notification_type == "school_time_out":
        return f"Attendance Notification: {name} exited the school at {time_value}."
    if notification_type == "event_time_in":
        event = str(event_name or "the event").strip() or "the event"
        return f"Event Attendance: {name} attended {event} at {time_value}."
    if notification_type == "event_time_out":
        event = str(event_name or "the event").strip() or "the event"
        return f"Event Attendance: {name} exited {event} at {time_value}."
    raise ValueError(f"Unsupported notification type: {notification_type}")


def resolve_guardian_phone(supabase_client: Any, student_id: str) -> dict[str, str | None]:
    """Resolve the primary guardian phone, falling back to alternate_phone_number."""
    if not student_id:
        return {"phone_number": None, "guardian_id": None}

    links = (
        supabase_client.table("student_guardians")
        .select("guardian_id, is_primary_contact")
        .eq("student_id", student_id)
        .order("is_primary_contact", desc=True)
        .execute()
    )
    link_rows = links.data or []
    guardian_ids = [str(row.get("guardian_id")) for row in link_rows if row.get("guardian_id")]
    if not guardian_ids:
        return {"phone_number": None, "guardian_id": None}

    guardians = (
        supabase_client.table("guardians")
        .select("guardian_id, phone_number, alternate_phone_number")
        .in_("guardian_id", guardian_ids)
        .execute()
    )
    by_id = {str(row.get("guardian_id")): row for row in (guardians.data or [])}

    for guardian_id in guardian_ids:
        row = by_id.get(guardian_id, {})
        phone = str(row.get("phone_number") or "").strip()
        alternate = str(row.get("alternate_phone_number") or "").strip()
        if phone:
            return {"phone_number": phone, "guardian_id": guardian_id}
        if alternate:
            return {"phone_number": alternate, "guardian_id": guardian_id}

    return {"phone_number": None, "guardian_id": guardian_ids[0]}


def _configured_provider() -> tuple[str, str, int | None, str | None]:
    api_url = os.getenv("IPROG_API_URL", DEFAULT_API_URL).strip()
    api_token = os.getenv("IPROG_API_TOKEN", "").strip()
    provider_raw = os.getenv("IPROG_SMS_PROVIDER", str(DEFAULT_SMS_PROVIDER)).strip()
    try:
        provider = int(provider_raw)
    except ValueError:
        return api_url, api_token, None, "IPROG_SMS_PROVIDER must be 0, 1, or 2"
    if provider not in SMS_PROVIDER_VALUES:
        return api_url, api_token, None, "IPROG_SMS_PROVIDER must be 0, 1, or 2"
    return api_url, api_token, provider, None


def _provider_error_details(raw_body: str) -> dict[str, Any]:
    """Extract non-secret provider diagnostics from an error response."""
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        text = " ".join(str(raw_body or "").split())
        return {"provider_message": text[:300]} if text else {}

    details: dict[str, Any] = {}
    for key in ("status", "message", "error", "errors"):
        if key in payload and payload[key] is not None:
            value = payload[key]
            details["provider_message" if key in {"message", "error", "errors"} else "provider_status"] = str(value)[:300]
    return details


def _safe_provider_text(value: Any, secrets: list[str]) -> str | None:
    text = " ".join(str(value or "").split())
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text[:300] or None


def _audit_result(**values: Any) -> dict[str, Any]:
    result = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "request_attempted": False,
        "http_status": None,
        "provider_status": None,
        "provider_message": None,
        "provider_message_id": None,
        "result": "NOT_ATTEMPTED",
        "failure_reason": None,
    }
    result.update(values)
    return result


def send_sms(phone_number: str, message: str, timeout_seconds: float = 8.0) -> dict[str, Any]:
    """Queue one SMS with iPROG and return a token-free structured result."""
    normalized_phone = normalize_philippine_mobile(phone_number)
    if not normalized_phone:
        return _audit_result(
            success=False,
            status="invalid_phone",
            message="Invalid Philippine mobile number",
            failure_reason="INVALID_PHONE",
        )
    if not str(message or "").strip():
        return _audit_result(
            success=False,
            status="invalid_message",
            message="SMS message is empty",
            failure_reason="EMPTY_MESSAGE",
        )

    api_url, api_token, provider, config_error = _configured_provider()
    if not api_token:
        return _audit_result(
            success=False,
            status="missing_configuration",
            message="IPROG_API_TOKEN is not configured",
            failure_reason="MISSING_API_TOKEN",
        )
    if not api_url:
        return _audit_result(
            success=False,
            status="missing_configuration",
            message="IPROG_API_URL is not configured",
            failure_reason="MISSING_API_URL",
        )
    if config_error:
        return _audit_result(
            success=False,
            status="invalid_configuration",
            message=config_error,
            failure_reason="INVALID_SMS_PROVIDER",
        )

    request_body = json.dumps({
        "api_token": api_token,
        "phone_number": normalized_phone,
        "message": str(message),
        "sms_provider": provider,
    }).encode("utf-8")
    request = urllib.request.Request(
        api_url,
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": SMS_USER_AGENT,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            http_status = int(response.status)
            raw_body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raw_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        provider_details = _provider_error_details(raw_body)
        safe_message = _safe_provider_text(provider_details.get("provider_message"), [api_token, normalized_phone, str(phone_number)])
        result = {
            "success": False,
            "status": f"http_{exc.code}",
            "message": "iPROG rejected the SMS request",
            "request_attempted": True,
            "http_status": exc.code,
            "result": "FAILED",
            "failure_reason": "PROVIDER_HTTP_ERROR",
            "provider_message": safe_message,
        }
        return result
    except urllib.error.URLError:
        return _audit_result(
            success=False,
            status="connection_error",
            message="Could not connect to iPROG",
            request_attempted=True,
            result="FAILED",
            failure_reason="CONNECTION_ERROR",
        )
    except TimeoutError:
        return _audit_result(
            success=False,
            status="timeout",
            message="iPROG request timed out",
            request_attempted=True,
            result="FAILED",
            failure_reason="TIMEOUT",
        )
    except Exception:
        return _audit_result(
            success=False,
            status="request_error",
            message="Unexpected iPROG request error",
            request_attempted=True,
            result="FAILED",
            failure_reason="REQUEST_ERROR",
        )

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return _audit_result(
            success=False,
            status="invalid_response",
            message="iPROG returned invalid JSON",
            request_attempted=True,
            http_status=http_status,
            result="FAILED",
            failure_reason="MALFORMED_PROVIDER_RESPONSE",
        )

    provider_status = payload.get("status")
    message_id = str(payload.get("message_id") or "").strip()
    provider_message = _safe_provider_text(payload.get("message"), [api_token, normalized_phone, str(phone_number)])
    status_success = http_status in range(200, 300) and str(provider_status) in {"200", "201"}
    if status_success and message_id:
        return {
            "success": True,
            "status": provider_status,
            "message": "SMS request accepted/queued by iPROG",
            "message_id": message_id,
            "request_attempted": True,
            "http_status": http_status,
            "provider_status": provider_status,
            "provider_message": provider_message,
            "provider_message_id": message_id,
            "result": "SUCCESS_QUEUED",
            "failure_reason": None,
        }
    if status_success:
        return _audit_result(
            success=False,
            status="missing_message_id",
            message="iPROG response did not include message_id",
            request_attempted=True,
            http_status=http_status,
            provider_status=provider_status,
            provider_message=provider_message,
            result="FAILED",
            failure_reason="MISSING_PROVIDER_MESSAGE_ID",
        )

    return _audit_result(
        success=False,
        status=provider_status or f"http_{http_status}",
        message="iPROG rejected the SMS request",
        request_attempted=True,
        http_status=http_status,
        provider_status=provider_status,
        provider_message=provider_message,
        result="FAILED",
        failure_reason="PROVIDER_STATUS_ERROR",
    )
