-- Durable, server-owned SMS state for QR/ID school gate transactions.
-- Face recognition keeps its existing notification path; this table has no
-- trigger and does not enqueue any historical or future gate row by itself.
begin;

create table public.gate_sms_notifications (
    notification_id uuid primary key default gen_random_uuid(),
    entry_exit_log_id uuid not null unique
        references public.entry_exit_logs(id) on delete cascade,
    student_id uuid references public.students(student_id) on delete set null,
    status text not null default 'claimed'
        check (status in ('claimed', 'sending', 'accepted', 'failed', 'uncertain', 'suppressed')),
    provider_status text,
    provider_message_id text,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    accepted_at timestamptz
);

create index gate_sms_notifications_student_id_idx
    on public.gate_sms_notifications(student_id);

alter table public.gate_sms_notifications enable row level security;
revoke all on public.gate_sms_notifications from public, anon, authenticated, service_role;
grant select, insert, update on public.gate_sms_notifications to service_role;

-- No anon/authenticated policies: only the server-side secret-key client may
-- claim a log and record provider status. The unique log ID is the durable
-- duplicate barrier, including across engine restarts and concurrent calls.
commit;
