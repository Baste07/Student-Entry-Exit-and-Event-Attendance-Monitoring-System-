-- Allow a separate, bounded Event Attendance cooldown without changing gate settings.
-- Apply before enabling the Event Settings control. Existing preferences are preserved.
begin;

alter table public.event_settings
    drop constraint if exists event_settings_supported_values;

alter table public.event_settings
    add constraint event_settings_supported_values check (
        (key = 'sms_enabled' and value in ('true', 'false'))
        or (key = 'late_grace_minutes' and value ~ '^(0|[1-9][0-9]?)$')
        or (key = 'attendance_cooldown_seconds'
            and value ~ '^([1-9]|[1-9][0-9]|[12][0-9][0-9]|300)$')
    );

insert into public.event_settings (key, value)
values ('attendance_cooldown_seconds', '5')
on conflict (key) do nothing;

commit;
