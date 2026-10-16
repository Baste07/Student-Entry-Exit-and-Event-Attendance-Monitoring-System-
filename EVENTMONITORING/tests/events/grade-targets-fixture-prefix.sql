begin;
create schema codex_event_target_test;
create schema codex_event_target_private;
grant usage on schema codex_event_target_test, codex_event_target_private to authenticated, anon;
-- Only the isolated test helper is simulated. Production uses its existing
-- active, unlocked AAL2 Admin helper unchanged.
create function codex_event_target_private.is_active_admin_aal2()
returns boolean language sql stable as $$
 select current_setting('codex.event_target_state', true) in ('super-aal2','admin-aal2')
$$;
create table codex_event_target_test.school_years(id uuid primary key);
create table codex_event_target_test.events(
 event_id uuid primary key default gen_random_uuid(), event_name varchar not null,
 description text, event_date date not null, time_start time, time_end time,
 location varchar, status varchar, created_by uuid, created_at timestamptz default now(),
 updated_at timestamptz default now(), event_type varchar, target_grade_level text,
 target_section text, end_date date
);
create table codex_event_target_test.sections(
 section_id uuid primary key default gen_random_uuid(), grade_level varchar not null,
 section_name varchar not null, school_year_id uuid references codex_event_target_test.school_years(id)
);
create table codex_event_target_test.students(
 student_id uuid primary key default gen_random_uuid(), section_id uuid references codex_event_target_test.sections(section_id),
 school_year_id uuid references codex_event_target_test.school_years(id), current_grade_level varchar,
 status text
);
create table codex_event_target_test.event_participants(
 participant_id uuid primary key default gen_random_uuid(), event_id uuid not null references codex_event_target_test.events(event_id) on delete cascade,
 student_id uuid not null references codex_event_target_test.students(student_id) on delete cascade,
 added_by uuid, added_at timestamptz default now(), unique(event_id,student_id)
);
create table codex_event_target_test.event_attendance(
 attendance_id uuid primary key default gen_random_uuid(),
 event_id uuid not null references codex_event_target_test.events(event_id),
 student_id uuid references codex_event_target_test.students(student_id),
 time_in timestamptz, time_out timestamptz,
 unique(event_id,student_id)
);
