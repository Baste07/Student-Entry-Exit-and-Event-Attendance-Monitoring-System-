-- DRAFT FOR REVIEW. Do not apply until a Production-compatible transactional
-- test and a separate Production approval have completed.
-- Additive grade/section targeting for NEW Events. Installation does not
-- populate these tables or change any existing Event or participant row.
begin;

create table public.event_grade_targets (
  target_id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(event_id) on delete cascade,
  school_year_id uuid not null references public.school_years(id),
  grade_level varchar not null,
  all_sections boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_grade_targets_grade_check
    check (grade_level in ('Kinder', 'Grade 1', 'Grade 2', 'Grade 3',
                           'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7',
                           'Grade 8', 'Grade 9', 'Grade 10')),
  constraint event_grade_targets_event_year_grade_key
    unique (event_id, school_year_id, grade_level)
);

create table public.event_grade_target_sections (
  target_id uuid not null references public.event_grade_targets(target_id)
    on delete cascade,
  section_id uuid not null references public.sections(section_id),
  primary key (target_id, section_id)
);

create index event_grade_targets_school_year_grade_idx
  on public.event_grade_targets(school_year_id, grade_level, event_id);
create index event_grade_target_sections_section_idx
  on public.event_grade_target_sections(section_id);

-- Browser users may inspect targeting at AAL2. All writes go through the
-- explicit AAL2 RPC below, so separate Data API calls cannot save half an Event.
revoke all on public.event_grade_targets,
              public.event_grade_target_sections from public, anon, authenticated;
grant select on public.event_grade_targets,
                public.event_grade_target_sections to authenticated;
alter table public.event_grade_targets enable row level security;
alter table public.event_grade_target_sections enable row level security;

create policy "AAL2 admins read Event grade targets"
  on public.event_grade_targets as permissive for select to authenticated
  using ((select app_private.is_active_admin_aal2()));
create policy "Admin MFA boundary"
  on public.event_grade_targets as restrictive for all to authenticated
  using ((select app_private.is_active_admin_aal2()))
  with check ((select app_private.is_active_admin_aal2()));
create policy "AAL2 admins read Event target sections"
  on public.event_grade_target_sections as permissive for select to authenticated
  using ((select app_private.is_active_admin_aal2()));
create policy "Admin MFA boundary"
  on public.event_grade_target_sections as restrictive for all to authenticated
  using ((select app_private.is_active_admin_aal2()))
  with check ((select app_private.is_active_admin_aal2()));

-- Existing Event/participant policies and legacy Events are untouched.
-- For a newly normalized Event, only the database sync may alter its roster;
-- the existing browser's separate participant requests cannot drift it.
create policy "Normalized Event roster is database managed on insert"
  on public.event_participants as restrictive for insert to authenticated
  with check (not exists (
    select 1 from public.event_grade_targets t
    where t.event_id = event_participants.event_id
  ));
create policy "Normalized Event roster is database managed on update"
  on public.event_participants as restrictive for update to authenticated
  using (not exists (
    select 1 from public.event_grade_targets t
    where t.event_id = event_participants.event_id
  ))
  with check (not exists (
    select 1 from public.event_grade_targets t
    where t.event_id = event_participants.event_id
  ));
create policy "Normalized Event roster is database managed on delete"
  on public.event_participants as restrictive for delete to authenticated
  using (not exists (
    select 1 from public.event_grade_targets t
    where t.event_id = event_participants.event_id
  ));

-- The child guard locks the section first, then its target. A concurrent
-- section metadata edit cannot invalidate a just-selected section unnoticed.
create function app_private.guard_event_target_section()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_section public.sections%rowtype;
  v_target public.event_grade_targets%rowtype;
begin
  if tg_op <> 'DELETE' then
    select * into v_section from public.sections
      where section_id = new.section_id for share;
    if not found then
      raise exception 'Selected section does not exist' using errcode = '23503';
    end if;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    perform 1 from public.event_grade_targets
      where target_id = old.target_id for update;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select * into v_target from public.event_grade_targets
    where target_id = new.target_id for update;
  if not found then
    raise exception 'Event grade target does not exist' using errcode = '23503';
  end if;
  if v_target.all_sections then
    raise exception 'All Sections targets cannot contain specific sections'
      using errcode = '23514';
  end if;
  if v_section.school_year_id is distinct from v_target.school_year_id
     or v_section.grade_level is distinct from v_target.grade_level then
    raise exception 'Selected section must match target grade and school year'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_event_target_section
  before insert or update or delete on public.event_grade_target_sections
  for each row execute function app_private.guard_event_target_section();

-- Cardinality is deferred so a single transaction can insert a specific-
-- sections parent followed by its children, or replace a whole rule set.
create function app_private.assert_event_grade_target_id(p_target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_all_sections boolean;
  v_child_count integer;
begin
  select all_sections into v_all_sections from public.event_grade_targets
    where target_id = p_target_id for update;
  if not found then
    return; -- Parent deleted in the same transaction.
  end if;
  select count(*) into v_child_count
    from public.event_grade_target_sections where target_id = p_target_id;
  if (v_all_sections and v_child_count <> 0)
     or (not v_all_sections and v_child_count = 0) then
    raise exception 'Event target must have no sections for All Sections, or at least one specific section'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.event_grade_target_sections ts
    join public.sections s on s.section_id = ts.section_id
    join public.event_grade_targets t on t.target_id = ts.target_id
    where ts.target_id = p_target_id
      and (s.grade_level is distinct from t.grade_level
           or s.school_year_id is distinct from t.school_year_id)
  ) then
    raise exception 'Selected section must match target grade and school year'
      using errcode = '23514';
  end if;
end;
$$;

create function app_private.assert_event_grade_target()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_target_id uuid;
begin
  if tg_table_name = 'event_grade_targets' then
    v_target_id := case when tg_op = 'DELETE' then old.target_id
                        else new.target_id end;
  else
    if tg_op = 'UPDATE' then
      if old.target_id is distinct from new.target_id then
        perform app_private.assert_event_grade_target_id(old.target_id);
      end if;
    end if;
    v_target_id := case when tg_op = 'DELETE' then old.target_id
                        else new.target_id end;
  end if;
  perform app_private.assert_event_grade_target_id(v_target_id);
  return null;
end;
$$;

create constraint trigger event_grade_target_complete
  after insert or update or delete on public.event_grade_targets
  deferrable initially deferred for each row
  execute function app_private.assert_event_grade_target();
create constraint trigger event_grade_target_sections_complete
  after insert or update or delete on public.event_grade_target_sections
  deferrable initially deferred for each row
  execute function app_private.assert_event_grade_target();

-- One shared eligibility predicate is used by both preview and roster sync.
-- A student must be active and their own year/grade/section must all agree.
create function app_private.eligible_event_students(
  p_rules jsonb, p_student_id uuid default null
)
returns table(student_id uuid) language sql stable security invoker
set search_path = '' as $$
  with rules as (
    select (r.value->>'school_year_id')::uuid as school_year_id,
           r.value->>'grade_level' as grade_level,
           (r.value->>'all_sections')::boolean as all_sections,
           r.value->'section_ids' as section_ids
    from pg_catalog.jsonb_array_elements(p_rules) as r(value)
  )
  select distinct s.student_id
  from public.students s
  join public.sections sec on sec.section_id = s.section_id
  join rules r on r.school_year_id = s.school_year_id
              and r.grade_level = s.current_grade_level
              and r.school_year_id = sec.school_year_id
              and r.grade_level = sec.grade_level
  where s.status::text = 'active'
    and (p_student_id is null or s.student_id = p_student_id)
    and (r.all_sections or r.section_ids ? s.section_id::text);
$$;

create function app_private.validate_event_grade_rules(
  p_school_year_id uuid, p_targets jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_rule jsonb;
  v_grade text;
  v_all boolean;
  v_sections jsonb;
  v_section_text text;
  v_section_id uuid;
  v_seen_grades text[] := array[]::text[];
  v_seen_sections uuid[];
begin
  if not exists (select 1 from public.school_years where id = p_school_year_id) then
    raise exception 'School year does not exist' using errcode = '23503';
  end if;
  if pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_targets) = 0 then
    raise exception 'At least one grade target is required' using errcode = '23514';
  end if;
  for v_rule in select value from pg_catalog.jsonb_array_elements(p_targets) as r(value) loop
    if pg_catalog.jsonb_typeof(v_rule) is distinct from 'object'
       or pg_catalog.jsonb_typeof(v_rule->'all_sections') is distinct from 'boolean'
       or pg_catalog.jsonb_typeof(v_rule->'section_ids') is distinct from 'array' then
      raise exception 'Invalid Event grade target structure' using errcode = '23514';
    end if;
    v_grade := v_rule->>'grade_level';
    if v_grade is null or v_grade !~ '^(Kinder|Grade ([1-9]|10))$'
       or v_grade = any(v_seen_grades) then
      raise exception 'Invalid or duplicate grade target' using errcode = '23514';
    end if;
    v_seen_grades := pg_catalog.array_append(v_seen_grades, v_grade);
    v_all := (v_rule->>'all_sections')::boolean;
    v_sections := v_rule->'section_ids';
    if (v_all and pg_catalog.jsonb_array_length(v_sections) <> 0)
       or (not v_all and pg_catalog.jsonb_array_length(v_sections) = 0) then
      raise exception 'Invalid All Sections or specific-section selection'
        using errcode = '23514';
    end if;
    v_seen_sections := array[]::uuid[];
    for v_section_text in
      select value from pg_catalog.jsonb_array_elements_text(v_sections) as s(value)
    loop
      v_section_id := v_section_text::uuid;
      if v_section_id = any(v_seen_sections) then
        raise exception 'Duplicate section target' using errcode = '23505';
      end if;
      v_seen_sections := pg_catalog.array_append(v_seen_sections, v_section_id);
      perform 1 from public.sections
        where section_id = v_section_id and school_year_id = p_school_year_id
          and grade_level = v_grade for share;
      if not found then
        raise exception 'Selected section must match target grade and school year'
          using errcode = '23514';
      end if;
    end loop;
  end loop;
end;
$$;

-- A metadata-only edit of unchanged normalized rules must not rebuild a
-- historical roster, including one belonging to a completed Event.
create function app_private.same_event_grade_targets(
  p_event_id uuid, p_school_year_id uuid, p_targets jsonb
)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_rule jsonb;
  v_target public.event_grade_targets%rowtype;
  v_existing uuid[];
  v_requested uuid[];
begin
  if p_event_id is null or (
    select count(*) from public.event_grade_targets where event_id = p_event_id
  ) <> pg_catalog.jsonb_array_length(p_targets) then
    return false;
  end if;
  for v_rule in select value from pg_catalog.jsonb_array_elements(p_targets) as r(value) loop
    select * into v_target from public.event_grade_targets
      where event_id = p_event_id and grade_level = v_rule->>'grade_level';
    if not found or v_target.school_year_id <> p_school_year_id
       or v_target.all_sections <> (v_rule->>'all_sections')::boolean then
      return false;
    end if;
    select pg_catalog.array_agg(ts.section_id order by ts.section_id) into v_existing
      from public.event_grade_target_sections ts where ts.target_id = v_target.target_id;
    select pg_catalog.array_agg(s.value::uuid order by s.value::uuid) into v_requested
      from pg_catalog.jsonb_array_elements_text(v_rule->'section_ids') as s(value);
    if coalesce(v_existing, array[]::uuid[]) <> coalesce(v_requested, array[]::uuid[]) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- With no student ID, rebuild the Event's full materialized student roster.
-- Enrollment triggers pass one student ID, avoiding a full roster scan for
-- each row of a bulk import. Employee attendance is stored separately in
-- event_attendance and is never modified here.
create function app_private.sync_event_participants(
  p_event_id uuid, p_student_id uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_rules jsonb;
begin
  perform 1 from public.events where event_id = p_event_id for update;
  if not found then
    raise exception 'Event does not exist' using errcode = '23503';
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'school_year_id', t.school_year_id,
    'grade_level', t.grade_level,
    'all_sections', t.all_sections,
    'section_ids', coalesce((
      select pg_catalog.jsonb_agg(ts.section_id::text)
      from public.event_grade_target_sections ts where ts.target_id = t.target_id
    ), '[]'::jsonb)
  )) into v_rules
  from public.event_grade_targets t where t.event_id = p_event_id;
  if v_rules is null then
    return; -- Legacy and individually selected Events are never rewritten.
  end if;

  with eligible as materialized (
    select student_id from app_private.eligible_event_students(v_rules, p_student_id)
  )
  delete from public.event_participants ep
    where ep.event_id = p_event_id
      and (p_student_id is null or ep.student_id = p_student_id)
      and not exists (select 1 from eligible e where e.student_id = ep.student_id)
      -- A prior Time In must keep its roster link so the same student can
      -- complete Time Out after a later enrollment or section change.
      and not exists (
        select 1 from public.event_attendance ea
        where ea.event_id = ep.event_id and ea.student_id = ep.student_id
      );

  insert into public.event_participants(event_id, student_id, added_by)
    select p_event_id, student_id, null
      from app_private.eligible_event_students(v_rules, p_student_id)
    on conflict (event_id, student_id) do nothing;
end;
$$;

-- A read-only preview uses precisely the same eligibility function as sync.
create function public.preview_event_grade_participants(
  p_school_year_id uuid, p_targets jsonb, p_event_id uuid default null
)
returns table(student_id uuid) language plpgsql security definer
set search_path = '' as $$
declare v_rules jsonb;
begin
  if (select auth.uid()) is null
     or not (select app_private.is_active_admin_aal2()) then
    raise exception 'Active AAL2 Admin required' using errcode = '42501';
  end if;
  perform app_private.validate_event_grade_rules(p_school_year_id, p_targets);
  select pg_catalog.jsonb_agg(value || pg_catalog.jsonb_build_object(
    'school_year_id', p_school_year_id)) into v_rules
    from pg_catalog.jsonb_array_elements(p_targets) as r(value);
  return query
    select e.student_id from app_private.eligible_event_students(v_rules) e
    union
    select ep.student_id from public.event_participants ep
      where ep.event_id = p_event_id
        and exists (
          select 1 from public.event_grade_targets t where t.event_id = p_event_id
        )
        and (
          app_private.same_event_grade_targets(p_event_id, p_school_year_id, p_targets)
          or exists (
            select 1 from public.event_attendance ea
            where ea.event_id = ep.event_id and ea.student_id = ep.student_id
          )
        );
end;
$$;

-- This RPC is one PostgreSQL transaction when called via PostgREST. It will
-- not edit legacy or individual Events: those require explicit review first.
create function public.save_grade_targeted_event(
  p_event jsonb, p_school_year_id uuid, p_targets jsonb,
  p_event_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_event_id uuid;
  v_rule jsonb;
  v_target_id uuid;
  v_section_text text;
  v_rules_unchanged boolean := false;
begin
  if (select auth.uid()) is null
     or not (select app_private.is_active_admin_aal2()) then
    raise exception 'Active AAL2 Admin required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_event) is distinct from 'object'
     or nullif(pg_catalog.btrim(p_event->>'event_name'), '') is null
     or nullif(p_event->>'event_date', '') is null
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_event) as k(key)
       where k.key not in ('event_name','event_date','end_date','event_type',
                           'time_start','time_end','location','status','description')
     ) then
    raise exception 'Invalid Event fields' using errcode = '23514';
  end if;
  perform app_private.validate_event_grade_rules(p_school_year_id, p_targets);

  if p_event_id is null then
    insert into public.events (
      event_name, event_date, end_date, event_type, time_start, time_end,
      location, status, description, target_grade_level, target_section, created_by
    ) values (
      pg_catalog.btrim(p_event->>'event_name'), (p_event->>'event_date')::date,
      nullif(p_event->>'end_date', '')::date, p_event->>'event_type',
      nullif(p_event->>'time_start', '')::time,
      nullif(p_event->>'time_end', '')::time,
      p_event->>'location', coalesce(p_event->>'status', 'upcoming'),
      p_event->>'description', null, null, (select auth.uid())
    ) returning event_id into v_event_id;
  else
    select event_id into v_event_id from public.events
      where event_id = p_event_id for update;
    if not found then
      raise exception 'Event does not exist' using errcode = '23503';
    end if;
    if not exists (select 1 from public.event_grade_targets
                   where event_id = p_event_id) then
      raise exception 'Legacy or individual Event requires explicit conversion review'
        using errcode = '23514';
    end if;
    v_rules_unchanged := app_private.same_event_grade_targets(
      p_event_id, p_school_year_id, p_targets);
    update public.events set
      event_name = pg_catalog.btrim(p_event->>'event_name'),
      event_date = (p_event->>'event_date')::date,
      end_date = nullif(p_event->>'end_date', '')::date,
      event_type = p_event->>'event_type',
      time_start = nullif(p_event->>'time_start', '')::time,
      time_end = nullif(p_event->>'time_end', '')::time,
      location = p_event->>'location',
      status = coalesce(p_event->>'status', 'upcoming'),
      description = p_event->>'description',
      target_grade_level = null, target_section = null,
      updated_at = pg_catalog.now()
      where event_id = v_event_id;
    if not v_rules_unchanged then
      delete from public.event_grade_targets where event_id = v_event_id;
    end if;
  end if;

  if not v_rules_unchanged then
    for v_rule in select value from pg_catalog.jsonb_array_elements(p_targets) as r(value) loop
      insert into public.event_grade_targets(
        event_id, school_year_id, grade_level, all_sections
      ) values (
        v_event_id, p_school_year_id, v_rule->>'grade_level',
        (v_rule->>'all_sections')::boolean
      ) returning target_id into v_target_id;
      for v_section_text in
        select value from pg_catalog.jsonb_array_elements_text(v_rule->'section_ids') as s(value)
      loop
        insert into public.event_grade_target_sections(target_id, section_id)
          values (v_target_id, v_section_text::uuid);
      end loop;
    end loop;
    perform app_private.sync_event_participants(v_event_id);
  end if;
  return v_event_id;
end;
$$;

-- Only changed enrollment/assignment rows can trigger a one-student sync for
-- future/ongoing Events. Completed Events remain frozen automatically. No
-- trigger is installed on recognition frames, attendance writes, or reads.
create function app_private.sync_event_targets_for_student()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_event_id uuid;
  v_old_year uuid;
  v_old_grade varchar;
  v_old_section uuid;
begin
  if tg_op = 'UPDATE' then
    if new.school_year_id is not distinct from old.school_year_id
       and new.current_grade_level is not distinct from old.current_grade_level
       and new.section_id is not distinct from old.section_id
       and new.status is not distinct from old.status then
      return new;
    end if;
    v_old_year := old.school_year_id;
    v_old_grade := old.current_grade_level;
    v_old_section := old.section_id;
  end if;
  for v_event_id in
    select distinct t.event_id
    from public.event_grade_targets t
    join public.events e on e.event_id = t.event_id
    where e.status in ('scheduled','upcoming','ongoing')
      and coalesce(e.end_date, e.event_date) >=
          (pg_catalog.now() at time zone 'Asia/Manila')::date
      and (
        (t.school_year_id = new.school_year_id
         and t.grade_level = new.current_grade_level
         and (t.all_sections or exists (
           select 1 from public.event_grade_target_sections ts
           where ts.target_id = t.target_id and ts.section_id = new.section_id
         )))
        or (t.school_year_id = v_old_year
            and t.grade_level = v_old_grade
            and (t.all_sections or exists (
              select 1 from public.event_grade_target_sections ts
              where ts.target_id = t.target_id and ts.section_id = v_old_section
            )))
      )
  loop
    perform app_private.sync_event_participants(v_event_id, new.student_id);
  end loop;
  return new;
end;
$$;

create trigger sync_event_targets_on_student_enrollment
  after insert or update of school_year_id, current_grade_level, section_id, status
  on public.students for each row
  execute function app_private.sync_event_targets_for_student();

-- A section rename does not affect membership. A grade/year reassignment is
-- rejected if that section is specifically targeted; All Sections Events are
-- resynchronized for the old and new grade/year when students are attached.
create function app_private.guard_and_sync_event_target_section_metadata()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_target_id uuid; v_event_id uuid;
begin
  if new.grade_level is not distinct from old.grade_level
     and new.school_year_id is not distinct from old.school_year_id then
    return new;
  end if;
  for v_target_id in
    select ts.target_id from public.event_grade_target_sections ts
    where ts.section_id = new.section_id order by ts.target_id
  loop
    perform 1 from public.event_grade_targets
      where target_id = v_target_id for update;
    if exists (
      select 1 from public.event_grade_targets t
      where t.target_id = v_target_id
        and (t.grade_level is distinct from new.grade_level
             or t.school_year_id is distinct from new.school_year_id)
    ) then
      raise exception 'A targeted section cannot move to another grade or school year'
        using errcode = '23514';
    end if;
  end loop;
  for v_event_id in
    select distinct t.event_id from public.event_grade_targets t
    join public.events e on e.event_id = t.event_id
    where e.status in ('scheduled','upcoming','ongoing')
      and coalesce(e.end_date, e.event_date) >=
          (pg_catalog.now() at time zone 'Asia/Manila')::date
      and ((t.school_year_id = old.school_year_id
            and t.grade_level = old.grade_level)
           or (t.school_year_id = new.school_year_id
               and t.grade_level = new.grade_level))
  loop
    perform app_private.sync_event_participants(v_event_id);
  end loop;
  return new;
end;
$$;

create trigger guard_and_sync_event_target_section_metadata
  after update of school_year_id, grade_level on public.sections
  for each row
  execute function app_private.guard_and_sync_event_target_section_metadata();

-- Private helpers and trigger functions are not browser RPCs. Public RPCs
-- independently check the caller's active/unlocked AAL2 Admin identity.
revoke all on function app_private.guard_event_target_section() from public, anon, authenticated;
revoke all on function app_private.assert_event_grade_target() from public, anon, authenticated;
revoke all on function app_private.assert_event_grade_target_id(uuid) from public, anon, authenticated;
revoke all on function app_private.eligible_event_students(jsonb, uuid) from public, anon, authenticated;
revoke all on function app_private.validate_event_grade_rules(uuid, jsonb) from public, anon, authenticated;
revoke all on function app_private.same_event_grade_targets(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app_private.sync_event_participants(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.sync_event_targets_for_student() from public, anon, authenticated;
revoke all on function app_private.guard_and_sync_event_target_section_metadata() from public, anon, authenticated;
revoke all on function public.preview_event_grade_participants(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.save_grade_targeted_event(jsonb, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.preview_event_grade_participants(uuid, jsonb, uuid) to authenticated;
grant execute on function public.save_grade_targeted_event(jsonb, uuid, jsonb, uuid) to authenticated;

commit;
