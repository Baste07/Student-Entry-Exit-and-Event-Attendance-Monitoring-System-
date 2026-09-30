-- DEVELOPMENT PROJECT ONLY. Requires the fixture and rollover migration.
-- Exercises database authorization with the two synthetic admin identities
-- already present in the development project. All fixture changes roll back.

begin;
select set_config('request.jwt.claim.sub',
    (select admin_id::text from public.admins
     where admin_level = 'admin' and status = 'active' limit 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
declare changed integer;
begin
    begin
        perform public.preview_student_id_rollover(gen_random_uuid());
        raise exception 'Normal Admin was allowed to preview';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.run_student_id_rollover(gen_random_uuid());
        raise exception 'Normal Admin was allowed to run';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.mark_student_rollover_qr_reissued(gen_random_uuid(), gen_random_uuid());
        raise exception 'Normal Admin was allowed to mark QR emails';
    exception when insufficient_privilege then null;
    end;
    update public.system_settings set value = '04-01'
     where key = 'school_year_end_month_day';
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'Normal Admin changed rollover date'; end if;
end $$;
rollback;

begin;
select set_config('request.jwt.claim.sub',
    (select admin_id::text from public.admins
     where admin_level = 'admin' and status = 'active' limit 1), true);
update public.admins set status = 'suspended'
 where admin_id = current_setting('request.jwt.claim.sub')::uuid;
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
declare changed integer;
begin
    begin
        perform public.preview_student_id_rollover(gen_random_uuid());
        raise exception 'Suspended Admin was allowed to preview';
    exception when insufficient_privilege then null;
    end;
    update public.system_settings set value = '04-01'
     where key = 'school_year_end_month_day';
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'Suspended Admin changed rollover date'; end if;
end $$;
rollback;

begin;
do $$
declare
    source_year uuid := gen_random_uuid();
    next_year uuid := gen_random_uuid();
    existing_section uuid := gen_random_uuid();
    student uuid := gen_random_uuid();
    serial text;
begin
    loop
        serial := lpad((5000 + floor(random() * 4000))::integer::text, 4, '0');
        exit when not exists(select 1 from public.students
                             where stud_id in ('K-' || serial, '1-' || serial));
    end loop;
    insert into public.school_years(id, name, start_date, end_date) values
      (source_year, '2019-2020 Identity Fixture', '2019-06-01', '2020-03-31'),
      (next_year, '2020-2021 Identity Fixture', '2020-06-01', '2021-03-31');
    insert into public.sections(section_id, grade_level, section_name, school_year_id)
      values (existing_section, 'Kinder', 'Identity Fixture', source_year);
    insert into public.students(student_id, stud_id, first_name, last_name,
                                section_id, school_year_id, status)
      values (student, 'K-' || serial, 'Fixture', 'Identity',
              existing_section, source_year, 'active');
    perform set_config('app.rollover_test_year', source_year::text, true);
    perform set_config('app.rollover_test_student', student::text, true);
    perform set_config('app.rollover_test_section', existing_section::text, true);
end $$;
select set_config('request.jwt.claim.sub',
    (select admin_id::text from public.admins
     where admin_level = 'super_admin' and status = 'active' limit 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
declare
    source_year uuid := current_setting('app.rollover_test_year')::uuid;
    student uuid := current_setting('app.rollover_test_student')::uuid;
    existing_section uuid := current_setting('app.rollover_test_section')::uuid;
    preview jsonb;
    outcome jsonb;
begin
    preview := public.preview_student_id_rollover(source_year);
    if not (preview->>'can_run')::boolean then
        raise exception 'Super Admin preview unexpectedly blocked: %', preview;
    end if;
    outcome := public.run_student_id_rollover(source_year);
    if outcome->>'result' <> 'completed' or (outcome->>'processed')::integer <> 1 then
        raise exception 'Super Admin run failed: %', outcome;
    end if;
    if not exists (select 1 from public.students
                   where student_id = student and section_id = existing_section) then
        raise exception 'Super Admin run changed the section assignment';
    end if;
    if not public.student_qr_uuid_required() then
        raise exception 'Legacy QR was not disabled after rollover';
    end if;
    if not public.mark_student_rollover_qr_reissued(source_year, student) then
        raise exception 'Super Admin could not mark QR email';
    end if;
    begin
        update public.system_settings set value = '02-30'
         where key = 'school_year_end_month_day';
        raise exception 'Invalid annual date was accepted';
    exception when check_violation then null;
    end;
    update public.system_settings set value = '04-01'
     where key = 'school_year_end_month_day';
    if not found then raise exception 'Super Admin could not change annual date'; end if;
    outcome := public.run_student_id_rollover(source_year);
    if outcome->>'result' <> 'already_completed' then
        raise exception 'Manual retry was not idempotent: %', outcome;
    end if;
end $$;
rollback;
