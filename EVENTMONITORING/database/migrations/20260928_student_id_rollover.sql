-- Student display-ID rollover. Apply only after 20260926_admins_security.sql,
-- 20260926_settings_architecture.sql, and 20260927_students_security.sql
-- have passed their production checks.
-- The immutable students.student_id UUID and its foreign keys are never changed.
-- This migration does not run a rollover when installed.

begin;

-- The formatted Student ID prefix is authoritative for current grade.
-- Section assignment persists across years and its grade is metadata only.
alter table public.students add column if not exists current_grade_level varchar(16);
-- When the student write boundary was installed first, make the new grade
-- column writable only through its existing Super Admin RLS boundary.
grant insert (current_grade_level), update (current_grade_level)
    on table public.students to authenticated;
alter table public.students drop constraint if exists students_current_grade_level_valid;
alter table public.students add constraint students_current_grade_level_valid
    check (current_grade_level is null or current_grade_level in
           ('Kinder', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4',
            'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'));
update public.students s
   set current_grade_level = case
       when upper(split_part(s.stud_id, '-', 1)) = 'K' then 'Kinder'
       else 'Grade ' || split_part(s.stud_id, '-', 1) end
 where s.stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
   and s.current_grade_level is distinct from case
       when upper(split_part(s.stud_id, '-', 1)) = 'K' then 'Kinder'
       else 'Grade ' || split_part(s.stud_id, '-', 1) end;
alter table public.students drop constraint if exists students_current_grade_matches_id;
alter table public.students add constraint students_current_grade_matches_id
    check (stud_id !~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
           or current_grade_level is not distinct from case
               when upper(split_part(stud_id, '-', 1)) = 'K' then 'Kinder'
               else 'Grade ' || split_part(stud_id, '-', 1) end);
create index if not exists students_current_grade_level_idx
    on public.students(current_grade_level) where status = 'active';

create schema if not exists student_rollover_private;
revoke all on schema student_rollover_private from public, anon, authenticated;

-- Import paths can omit the new field during a staged application rollout.
-- This initializes new records from their ID; rollover updates both fields.
create or replace function student_rollover_private.initialize_grade()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    if new.current_grade_level is null
       and new.stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$' then
        new.current_grade_level := case
            when upper(split_part(new.stud_id, '-', 1)) = 'K' then 'Kinder'
            else 'Grade ' || split_part(new.stud_id, '-', 1) end;
    end if;
    return new;
end;
$$;
revoke all on function student_rollover_private.initialize_grade()
    from public, anon, authenticated;
drop trigger if exists students_initialize_current_grade on public.students;
create trigger students_initialize_current_grade
before insert on public.students for each row
execute function student_rollover_private.initialize_grade();

-- A recurring month/day, not a year-specific date. February 29 is deliberately
-- excluded because this setting must have the same meaning every year.
alter table public.system_settings drop constraint if exists school_year_end_month_day_valid;
alter table public.system_settings add constraint school_year_end_month_day_valid check (
    key <> 'school_year_end_month_day' or
    case when value ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
        split_part(value, '-', 2)::integer <= case split_part(value, '-', 1)::integer
            when 2 then 28
            when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30
            else 31 end
    else false end
);
insert into public.system_settings(key, value)
values ('school_year_end_month_day', '03-25') on conflict (key) do nothing;

-- Preserve the hardened settings boundary while permitting this one new key.
drop policy if exists "Read system capabilities" on public.system_settings;
drop policy if exists "Super admins insert system capabilities" on public.system_settings;
drop policy if exists "Super admins update system capabilities" on public.system_settings;
drop policy if exists "System capability insert boundary" on public.system_settings;
drop policy if exists "System capability update boundary" on public.system_settings;
create policy "Read system capabilities" on public.system_settings for select
    to anon, authenticated
    using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day'));
create policy "Super admins insert system capabilities" on public.system_settings for insert
    to authenticated with check (
        key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day')
        and exists (select 1 from public.admins where admin_id = (select auth.uid())
                    and admin_level = 'super_admin' and status = 'active'));
create policy "Super admins update system capabilities" on public.system_settings for update
    to authenticated
    using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day')
           and exists (select 1 from public.admins where admin_id = (select auth.uid())
                       and admin_level = 'super_admin' and status = 'active'))
    with check (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day')
           and exists (select 1 from public.admins where admin_id = (select auth.uid())
                       and admin_level = 'super_admin' and status = 'active'));
create policy "System capability insert boundary" on public.system_settings as restrictive for insert
    to authenticated with check (
        key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day')
        and exists (select 1 from public.admins where admin_id = (select auth.uid())
                    and admin_level = 'super_admin' and status = 'active'));
create policy "System capability update boundary" on public.system_settings as restrictive for update
    to authenticated
    using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day')
           and exists (select 1 from public.admins where admin_id = (select auth.uid())
                       and admin_level = 'super_admin' and status = 'active'))
    with check (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day')
           and exists (select 1 from public.admins where admin_id = (select auth.uid())
                       and admin_level = 'super_admin' and status = 'active'));

create table if not exists public.student_id_rollovers (
    school_year_id uuid primary key references public.school_years(id),
    next_school_year_id uuid not null references public.school_years(id),
    school_year_end_month_day text not null,
    executed_at timestamptz not null default now(),
    execution_mode text not null check (execution_mode in ('automatic', 'manual')),
    executed_by uuid,
    processed_count integer not null check (processed_count >= 0),
    inactive_count integer not null check (inactive_count >= 0),
    highest_grade_count integer not null check (highest_grade_count >= 0)
);
create table if not exists public.student_id_rollover_changes (
    school_year_id uuid not null references public.student_id_rollovers(school_year_id),
    student_id uuid not null,
    old_stud_id text not null,
    new_stud_id text not null,
    changed_at timestamptz not null default now(),
    primary key (school_year_id, student_id),
    unique (school_year_id, old_stud_id),
    unique (school_year_id, new_stud_id)
);
create index if not exists student_id_rollover_changes_student_idx
    on public.student_id_rollover_changes(student_id);
create table if not exists public.student_id_rollover_qr_queue (
    school_year_id uuid not null references public.student_id_rollovers(school_year_id),
    student_id uuid not null,
    qr_reissued_at timestamptz,
    primary key (school_year_id, student_id)
);
alter table public.student_id_rollovers enable row level security;
alter table public.student_id_rollover_changes enable row level security;
alter table public.student_id_rollover_qr_queue enable row level security;
revoke all on public.student_id_rollovers, public.student_id_rollover_changes,
              public.student_id_rollover_qr_queue
    from public, anon, authenticated;
grant select on public.student_id_rollovers, public.student_id_rollover_changes,
                public.student_id_rollover_qr_queue
    to authenticated, service_role;
grant all on public.student_id_rollovers, public.student_id_rollover_changes,
             public.student_id_rollover_qr_queue to service_role;
drop policy if exists "Active super admins read rollover history" on public.student_id_rollovers;
create policy "Active super admins read rollover history" on public.student_id_rollovers
    for select to authenticated using (exists (
        select 1 from public.admins where admin_id = (select auth.uid())
            and admin_level = 'super_admin' and status = 'active'));
drop policy if exists "Active super admins read rollover changes" on public.student_id_rollover_changes;
create policy "Active super admins read rollover changes" on public.student_id_rollover_changes
    for select to authenticated using (exists (
        select 1 from public.admins where admin_id = (select auth.uid())
            and admin_level = 'super_admin' and status = 'active'));
drop policy if exists "Active super admins read QR reissue queue" on public.student_id_rollover_qr_queue;
create policy "Active super admins read QR reissue queue" on public.student_id_rollover_qr_queue
    for select to authenticated using (exists (
        select 1 from public.admins where admin_id = (select auth.uid())
            and admin_level = 'super_admin' and status = 'active'));

-- Scanner pages need only this one bit of history, not access to mapping rows.
create or replace function public.student_qr_uuid_required()
returns boolean language sql stable security definer set search_path = '' as $$
    select exists(select 1 from public.student_id_rollovers);
$$;
revoke all on function public.student_qr_uuid_required() from public;
grant execute on function public.student_qr_uuid_required() to anon, authenticated;

create or replace function public.mark_student_rollover_qr_reissued(p_school_year_id uuid, p_student_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not exists (select 1 from public.admins
                       where admin_id = (select auth.uid())
                         and admin_level = 'super_admin' and status = 'active') then
        raise exception 'Active Super Admin required' using errcode = '42501';
    end if;
    update public.student_id_rollover_qr_queue
       set qr_reissued_at = coalesce(qr_reissued_at, pg_catalog.now())
     where school_year_id = p_school_year_id and student_id = p_student_id;
    get diagnostics v_updated = row_count;
    return v_updated = 1;
end;
$$;
revoke all on function public.mark_student_rollover_qr_reissued(uuid, uuid) from public, anon;
grant execute on function public.mark_student_rollover_qr_reissued(uuid, uuid) to authenticated;

-- One plan is used by both preview and execution. Student grade and display-ID
-- prefix must agree; section metadata never gates the rollover.
create or replace function student_rollover_private.plan(p_year uuid, p_next uuid)
returns table(student_id uuid, old_stud_id text, new_stud_id text,
              current_grade text, next_grade text, issue text)
language sql stable security definer set search_path = '' as $$
with cohort as (
    select s.student_id, s.stud_id::text as old_stud_id, s.status::text as status,
           s.current_grade_level::text as current_grade,
           upper(split_part(s.stud_id::text, '-', 1)) as prefix,
           split_part(s.stud_id::text, '-', 2) as serial
    from public.students s
    where s.school_year_id = p_year
), prepared as (
    select c.*,
           case when c.old_stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
                         and c.prefix <> '10'
                then (case when c.prefix = 'K' then '1'
                           else (c.prefix::integer + 1)::text end) || '-' || c.serial
                else null end as proposed_id,
           case when c.old_stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
                         and c.prefix <> '10'
                then 'Grade ' || (case when c.prefix = 'K' then 1
                                      else c.prefix::integer + 1 end)::text
                else null end as proposed_grade
    from cohort c
), checked as (
    select p.*,
           case when p.status is distinct from 'active' then 'inactive'
                when p.old_stud_id !~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$' then 'invalid'
                when p.current_grade is distinct from
                     (case when p.prefix = 'K' then 'Kinder'
                           else 'Grade ' || p.prefix end) then 'grade_mismatch'
                when p.prefix = '10' then 'highest_grade'
                else 'ready' end as base_issue
    from prepared p
)
select c.student_id, c.old_stud_id, c.proposed_id, c.current_grade,
       c.proposed_grade,
       case when c.base_issue = 'ready' and occupied.student_id is not null
                     and mover.base_issue is distinct from 'ready' then 'collision'
            else c.base_issue end as issue
from checked c
left join public.students occupied on occupied.stud_id = c.proposed_id
                                  and occupied.student_id <> c.student_id
left join checked mover on mover.student_id = occupied.student_id;
$$;
revoke all on function student_rollover_private.plan(uuid, uuid) from public, anon, authenticated;

create or replace function student_rollover_private.summary(p_year uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
    v_source public.school_years%rowtype;
    v_next uuid;
    v_setting text;
    v_due date;
    v_done boolean;
    v_ready integer;
    v_invalid integer;
    v_grade_mismatch integer;
    v_collision integer;
    v_highest integer;
    v_inactive integer;
    v_examples jsonb;
    v_progression jsonb;
    v_issues jsonb;
    v_completed_at timestamptz;
    v_last_completed jsonb;
    v_next_scheduled jsonb;
begin
    select * into v_source from public.school_years where id = p_year;
    if not found then raise exception 'School year not found'; end if;
    select id into v_next from public.school_years
      where extract(year from start_date) = extract(year from v_source.end_date)
        and start_date > v_source.start_date
      order by start_date limit 1;
    select value into v_setting from public.system_settings
      where key = 'school_year_end_month_day';
    if v_setting is null then raise exception 'School-year end setting is missing'; end if;
    v_due := pg_catalog.make_date(extract(year from v_source.end_date)::integer,
              split_part(v_setting, '-', 1)::integer,
              split_part(v_setting, '-', 2)::integer) + 1;
    select exists(select 1 from public.student_id_rollovers where school_year_id = p_year)
      into v_done;
    select executed_at into v_completed_at from public.student_id_rollovers
      where school_year_id = p_year;
    select pg_catalog.jsonb_build_object('school_year', sy.name,
                                         'executed_at', r.executed_at,
                                         'processed', r.processed_count)
      into v_last_completed
      from public.student_id_rollovers r
      join public.school_years sy on sy.id = r.school_year_id
      order by r.executed_at desc limit 1;
    select pg_catalog.jsonb_build_object(
               'school_year', sy.name,
               'due_date', pg_catalog.make_date(
                   extract(year from sy.end_date)::integer,
                   split_part(v_setting, '-', 1)::integer,
                   split_part(v_setting, '-', 2)::integer) + 1)
      into v_next_scheduled
      from public.school_years sy
      where not exists (select 1 from public.student_id_rollovers r
                        where r.school_year_id = sy.id)
        and exists (select 1 from public.students s
                    where s.school_year_id = sy.id and s.status = 'active')
        and exists (select 1 from public.school_years following
                    where extract(year from following.start_date) = extract(year from sy.end_date)
                      and following.start_date > sy.start_date)
      order by sy.end_date limit 1;
    if v_next is not null then
        select count(*) filter (where issue = 'ready'),
               count(*) filter (where issue = 'invalid'),
               count(*) filter (where issue = 'grade_mismatch'),
               count(*) filter (where issue = 'collision'),
               count(*) filter (where issue = 'highest_grade'),
               count(*) filter (where issue = 'inactive')
        into v_ready, v_invalid, v_grade_mismatch, v_collision, v_highest, v_inactive
        from student_rollover_private.plan(p_year, v_next);
        select coalesce(pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object('old', old_stud_id,
                        'current_grade', current_grade, 'next_grade', next_grade,
                        'new', new_stud_id)), '[]'::jsonb)
        into v_examples from (
            select old_stud_id, new_stud_id, current_grade, next_grade
            from student_rollover_private.plan(p_year, v_next)
            where issue = 'ready' order by old_stud_id limit 10
        ) sample;
        select coalesce(pg_catalog.jsonb_object_agg(transition, total), '{}'::jsonb)
        into v_progression from (
            select current_grade || ' to ' || next_grade as transition,
                   count(*) as total
            from student_rollover_private.plan(p_year, v_next)
            where issue = 'ready'
            group by 1
        ) grouped;
        select coalesce(pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object('id', old_stud_id,
                        'target', new_stud_id, 'reason', issue)), '[]'::jsonb)
        into v_issues from (
            select old_stud_id, new_stud_id, issue
            from student_rollover_private.plan(p_year, v_next)
            where issue in ('invalid', 'grade_mismatch', 'collision')
            order by issue, old_stud_id limit 10
        ) sample;
    else
        v_ready := 0; v_invalid := 0; v_grade_mismatch := 0; v_collision := 0;
        v_highest := 0; v_inactive := 0;
        v_examples := '[]'::jsonb;
        v_progression := '{}'::jsonb;
        v_issues := '[]'::jsonb;
    end if;
    return pg_catalog.jsonb_build_object(
        'school_year_id', p_year, 'school_year', v_source.name,
        'next_school_year_id', v_next, 'end_month_day', v_setting,
        'eligible_after', v_due, 'already_processed', v_done,
        'completed_at', v_completed_at,
        'last_completed_rollover', v_last_completed,
        'next_scheduled_rollover', v_next_scheduled,
        'ready', v_ready, 'invalid', v_invalid,
        'grade_mismatch', v_grade_mismatch, 'collisions', v_collision,
        'highest_grade', v_highest,
        'inactive', v_inactive, 'examples', v_examples,
        'grade_progression', v_progression, 'issues', v_issues,
        'can_run', not v_done and v_next is not null
            and ((pg_catalog.now() at time zone 'Asia/Manila')::date >= v_due)
            and (v_ready + v_highest) > 0
            and v_invalid = 0 and v_grade_mismatch = 0 and v_collision = 0);
end;
$$;
revoke all on function student_rollover_private.summary(uuid) from public, anon, authenticated;

create or replace function public.preview_student_id_rollover(p_school_year_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not exists (select 1 from public.admins
                       where admin_id = (select auth.uid())
                         and admin_level = 'super_admin' and status = 'active') then
        raise exception 'Active Super Admin required' using errcode = '42501';
    end if;
    return student_rollover_private.summary(p_school_year_id);
end;
$$;
revoke all on function public.preview_student_id_rollover(uuid) from public, anon;
grant execute on function public.preview_student_id_rollover(uuid) to authenticated;

create or replace function student_rollover_private.perform(p_year uuid, p_mode text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_preview jsonb;
    v_next uuid;
    v_row record;
    v_updated integer;
    v_processed integer := 0;
begin
    if p_mode not in ('automatic', 'manual') then raise exception 'Invalid mode'; end if;
    v_preview := student_rollover_private.summary(p_year);
    if (v_preview->>'already_processed')::boolean then
        return v_preview || '{"result":"already_completed"}'::jsonb;
    end if;
    if not (v_preview->>'can_run')::boolean then
        return v_preview || '{"result":"pending"}'::jsonb;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(735219, 1);
    lock table public.students in share row exclusive mode;
    v_preview := student_rollover_private.summary(p_year);
    if (v_preview->>'already_processed')::boolean then
        return v_preview || '{"result":"already_completed"}'::jsonb;
    end if;
    if not (v_preview->>'can_run')::boolean then
        return v_preview || '{"result":"pending"}'::jsonb;
    end if;
    v_next := (v_preview->>'next_school_year_id')::uuid;
    insert into public.student_id_rollovers
      (school_year_id, next_school_year_id, school_year_end_month_day,
       execution_mode, executed_by, processed_count, inactive_count, highest_grade_count)
    values (p_year, v_next, v_preview->>'end_month_day', p_mode, p_actor,
            (v_preview->>'ready')::integer, (v_preview->>'inactive')::integer,
            (v_preview->>'highest_grade')::integer);
    -- Any active student with an old ID-only QR (including Grade 10) needs a
    -- UUID-based replacement once legacy QR codes are disabled.
    insert into public.student_id_rollover_qr_queue(school_year_id, student_id)
    select p_year, s.student_id from public.students s
    where s.status = 'active'
      and not exists (select 1 from public.student_id_rollover_qr_queue q
                      where q.student_id = s.student_id and q.qr_reissued_at is not null);
    -- Descending grades vacate each display ID before a lower grade takes it.
    for v_row in select * from student_rollover_private.plan(p_year, v_next)
                 where issue = 'ready'
                 order by case when split_part(old_stud_id, '-', 1) ilike 'K' then 0
                               else split_part(old_stud_id, '-', 1)::integer end desc,
                          old_stud_id
    loop
        update public.students
           set stud_id = v_row.new_stud_id,
               current_grade_level = v_row.next_grade,
               school_year_id = v_next,
               updated_at = pg_catalog.now()
         where student_id = v_row.student_id and stud_id = v_row.old_stud_id;
        get diagnostics v_updated = row_count;
        if v_updated <> 1 then raise exception 'Student changed during rollover'; end if;
        insert into public.student_id_rollover_changes
          (school_year_id, student_id, old_stud_id, new_stud_id)
        values (p_year, v_row.student_id, v_row.old_stud_id, v_row.new_stud_id);
        v_processed := v_processed + 1;
    end loop;
    if v_processed <> (v_preview->>'ready')::integer then
        raise exception 'Rollover count mismatch';
    end if;
    insert into public.system_audit_logs
       (id, user_id, action, module_name, page_name, target_table, target_id, details)
    values (pg_catalog.gen_random_uuid(), p_actor, 'STUDENT_ID_ROLLOVER',
            'system', 'system-settings.html', 'students', p_year::text,
            v_preview || pg_catalog.jsonb_build_object(
                'mode', p_mode, 'processed', v_processed, 'executed_at', pg_catalog.now()));
    return v_preview || pg_catalog.jsonb_build_object('result', 'completed',
                                                       'processed', v_processed);
end;
$$;
revoke all on function student_rollover_private.perform(uuid, text, uuid)
    from public, anon, authenticated;

create or replace function public.run_student_id_rollover(p_school_year_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not exists (select 1 from public.admins
                       where admin_id = (select auth.uid())
                         and admin_level = 'super_admin' and status = 'active') then
        raise exception 'Active Super Admin required' using errcode = '42501';
    end if;
    return student_rollover_private.perform(p_school_year_id, 'manual', (select auth.uid()));
end;
$$;
revoke all on function public.run_student_id_rollover(uuid) from public, anon;
grant execute on function public.run_student_id_rollover(uuid) to authenticated;

create or replace function student_rollover_private.run_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_year record; v_result jsonb; v_completed integer := 0;
begin
    for v_year in
        select sy.id from public.school_years sy
        where sy.start_date < (pg_catalog.now() at time zone 'Asia/Manila')::date
          and exists (select 1 from public.students s
                      where s.school_year_id = sy.id and s.status = 'active')
          and not exists (select 1 from public.student_id_rollovers r
                          where r.school_year_id = sy.id)
        order by sy.end_date
    loop
        v_result := student_rollover_private.perform(v_year.id, 'automatic', null);
        if v_result->>'result' = 'completed' then v_completed := v_completed + 1; end if;
    end loop;
    return v_completed;
end;
$$;
revoke all on function student_rollover_private.run_due() from public, anon, authenticated;

-- Supabase Cron runs on UTC. 16:05 UTC is 00:05 the following day in Manila.
-- The function checks the Manila calendar date, retries pending years daily,
-- and the history primary key plus transaction lock make retries idempotent.
create extension if not exists pg_cron;
do $$ begin
    if not exists (select 1 from cron.job where jobname = 'student-id-rollover-daily') then
        perform cron.schedule('student-id-rollover-daily', '5 16 * * *',
                              'select student_rollover_private.run_due()');
    end if;
end $$;

commit;
