-- DEVELOPMENT PROJECT ONLY. Run after 20260928_student_id_rollover.sql.
-- This synthetic fixture is wrapped in a transaction and intentionally rolls back.
-- Do not run it on the production project.
begin;

do $$
declare
    source_year uuid := gen_random_uuid();
    next_year uuid := gen_random_uuid();
    old_kinder uuid := gen_random_uuid();
    section_a uuid := gen_random_uuid();
    old_ten uuid := gen_random_uuid();
    kinder_student uuid := gen_random_uuid();
    grade_one_student uuid := gen_random_uuid();
    grade_two_student uuid := gen_random_uuid();
    grade_ten_student uuid := gen_random_uuid();
    inactive_student uuid := gen_random_uuid();
    collision_student uuid := gen_random_uuid();
    suffix_k text := '0002';
    suffix_one text := '0001';
    suffix_two text := '0099';
    suffix_ten text := '0015';
    suffix_inactive text := '0020';
    invalid_student uuid := gen_random_uuid();
    id_check_name text;
    grade_check_definition text;
    preview jsonb;
    outcome jsonb;
begin
    if exists (select 1 from public.students where stud_id in
               ('K-0002', '1-0001', '1-0002', '2-0001', '2-0099',
                '3-0099', '10-0015', '1-0020')) then
        raise exception 'Synthetic ID fixture conflicts with development data';
    end if;

    insert into public.school_years(id, name, start_date, end_date, is_active) values
      (source_year, '2019-2020 Rollover Fixture', '2019-06-01', '2020-03-31', false),
      (next_year, '2020-2021 Rollover Fixture', '2020-06-01', '2021-03-31', false);
    insert into public.sections(section_id, grade_level, section_name, school_year_id) values
      (old_kinder, 'Kinder', 'Fixture Old Kinder', source_year),
      (section_a, 'Grade 1', 'Existing Section A', source_year),
      (old_ten, 'Grade 10', 'Fixture Highest', source_year);
    insert into public.students(student_id, stud_id, first_name, last_name,
                                section_id, school_year_id, status) values
      (kinder_student, 'K-' || suffix_k, 'Fixture', 'Kinder', old_kinder, source_year, 'active'),
      (grade_one_student, '1-' || suffix_one, 'Fixture', 'One', section_a, source_year, 'active'),
      (grade_two_student, '2-' || suffix_two, 'Fixture', 'Two', section_a, source_year, 'active'),
      (grade_ten_student, '10-' || suffix_ten, 'Fixture', 'Ten', old_ten, source_year, 'active'),
      (inactive_student, '1-' || suffix_inactive, 'Fixture', 'Inactive', section_a, source_year, 'inactive'),
      (collision_student, '1-' || suffix_k, 'Fixture', 'Collision', old_kinder, source_year, 'inactive');

    insert into public.student_guardians(student_id) values (kinder_student);
    insert into public.event_participants(student_id) values (kinder_student);
    insert into public.event_attendance(student_id) values (kinder_student);
    insert into public.entry_exit_logs(student_id) values (kinder_student);

    -- No section was created for next_year and no student is reassigned.
    preview := student_rollover_private.summary(source_year);
    if (preview->>'collisions')::integer <> 1 or (preview->>'can_run')::boolean then
        raise exception 'Collision preflight test failed: %', preview;
    end if;
    delete from public.students where student_id = collision_student;

    -- Temporarily remove the fixture format check inside this rolled-back
    -- transaction so the defensive invalid-ID preflight can be exercised.
    select conname into id_check_name from pg_constraint
     where conrelid = 'public.students'::regclass and contype = 'c'
       and conname = 'students_stud_id_check'
     limit 1;
    if id_check_name is null then raise exception 'Fixture student ID check not found'; end if;
    execute format('alter table public.students drop constraint %I', id_check_name);
    insert into public.students(student_id, stud_id, first_name, last_name,
                                section_id, school_year_id, status)
      values (invalid_student, 'G1-' || suffix_k, 'Fixture', 'Invalid',
              section_a, source_year, 'active');
    preview := student_rollover_private.summary(source_year);
    if (preview->>'invalid')::integer <> 1 or (preview->>'can_run')::boolean then
        raise exception 'Invalid-ID preflight test failed: %', preview;
    end if;
    delete from public.students where student_id = invalid_student;

    -- The final constraint itself must reject an unknown grade for a valid ID.
    begin
        update public.students set current_grade_level = null
          where student_id = grade_one_student;
        raise exception 'NULL current grade was accepted for a valid Student ID';
    exception when check_violation then null; end;
    -- Corrupt only the rolled-back fixture to exercise the defensive preview.
    select pg_get_constraintdef(oid) into grade_check_definition from pg_constraint
      where conrelid='public.students'::regclass
        and conname='students_current_grade_matches_id';
    if grade_check_definition is null then raise exception 'Grade consistency check absent'; end if;
    alter table public.students drop constraint students_current_grade_matches_id;
    update public.students set current_grade_level = null where student_id = grade_one_student;
    preview := student_rollover_private.summary(source_year);
    if (preview->>'grade_mismatch')::integer <> 1
       or (preview->>'can_run')::boolean then
        raise exception 'Unverified student grade must block rollover: %', preview;
    end if;
    update public.students set current_grade_level = 'Grade 1'
      where student_id = grade_one_student;
    execute format('alter table public.students add constraint students_current_grade_matches_id %s',
                   grade_check_definition);

    preview := student_rollover_private.summary(source_year);
    if (preview->>'ready')::integer <> 3
       or (preview->>'highest_grade')::integer <> 1
       or (preview->>'inactive')::integer <> 1
       or (preview->>'grade_mismatch')::integer <> 0
       or preview->'grade_progression'->>'Grade 1 to Grade 2' <> '1'
       or preview->'grade_progression'->>'Kinder to Grade 1' <> '1'
       or preview ? 'awaiting_section'
       or preview->'next_scheduled_rollover'->>'due_date' <> '2020-03-26'
       or preview->>'last_completed_rollover' is not null
       or not (preview->>'can_run')::boolean then
        raise exception 'Prefix-only preview test failed: %', preview;
    end if;
    outcome := student_rollover_private.perform(source_year, 'manual', null);
    if outcome->>'result' <> 'completed' or (outcome->>'processed')::integer <> 3 then
        raise exception 'Rollover execution test failed: %', outcome;
    end if;
    if not exists(select 1 from public.students where student_id = kinder_student
                  and stud_id = '1-' || suffix_k and school_year_id = next_year
                  and section_id = old_kinder and current_grade_level = 'Grade 1')
       or not exists(select 1 from public.students where student_id = grade_one_student
                     and stud_id = '2-' || suffix_one and school_year_id = next_year
                     and section_id = section_a and current_grade_level = 'Grade 2')
       or not exists(select 1 from public.students where student_id = grade_two_student
                     and stud_id = '3-' || suffix_two and school_year_id = next_year
                     and section_id = section_a and current_grade_level = 'Grade 3')
       or not exists(select 1 from public.students where student_id = grade_ten_student
                     and stud_id = '10-' || suffix_ten and section_id = old_ten
                     and current_grade_level = 'Grade 10')
       or not exists(select 1 from public.students where student_id = inactive_student
                     and stud_id = '1-' || suffix_inactive and section_id = section_a) then
        raise exception 'Grade progression, section preservation, or skip test failed';
    end if;
    if (select count(*) from public.students where student_id = grade_one_student
        and current_grade_level = 'Grade 2') <> 1
       or (select count(*) from public.students where student_id = grade_one_student
           and current_grade_level = 'Grade 1') <> 0 then
        raise exception 'Promoted student did not move from Grade 1 to Grade 2 targeting';
    end if;
    if (select count(*) from public.student_id_rollover_changes
        where school_year_id = source_year) <> 3 then
        raise exception 'Mapping history test failed';
    end if;
    preview := student_rollover_private.summary(source_year);
    if preview->'last_completed_rollover'->>'school_year'
       <> '2019-2020 Rollover Fixture' then
        raise exception 'Last-completed preview was not updated: %', preview;
    end if;
    if not exists (select 1 from public.student_guardians g
                   join public.students s on s.student_id = g.student_id
                   where s.student_id = kinder_student and s.stud_id = '1-' || suffix_k)
       or not exists (select 1 from public.event_participants p
                      join public.students s on s.student_id = p.student_id
                      where s.student_id = kinder_student and s.stud_id = '1-' || suffix_k)
       or not exists (select 1 from public.event_attendance a
                      join public.students s on s.student_id = a.student_id
                      where s.student_id = kinder_student and s.stud_id = '1-' || suffix_k)
       or not exists (select 1 from public.entry_exit_logs l
                      join public.students s on s.student_id = l.student_id
                      where s.student_id = kinder_student and s.stud_id = '1-' || suffix_k) then
        raise exception 'UUID-linked attendance or guardian records were disconnected';
    end if;
    if (select count(*) from public.student_id_rollover_qr_queue
        where school_year_id = source_year) < 4 then
        raise exception 'QR replacement queue test failed';
    end if;
    outcome := student_rollover_private.perform(source_year, 'automatic', null);
    if outcome->>'result' <> 'already_completed' then
        raise exception 'Exactly-once retry test failed: %', outcome;
    end if;
    raise notice 'Synthetic rollover checks passed; changes will be rolled back.';
end $$;

rollback;
