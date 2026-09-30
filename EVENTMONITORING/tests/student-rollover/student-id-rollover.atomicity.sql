-- DEVELOPMENT PROJECT ONLY. Synthetic failure, automatic run, and retry checks.
-- All writes, including the temporary trigger, roll back.
begin;

create function pg_temp.reject_second_rollover_update()
returns trigger language plpgsql as $$
begin
    if new.first_name = 'Second' and new.stud_id <> old.stud_id then
        raise exception 'Synthetic second-row failure';
    end if;
    return new;
end;
$$;
create trigger reject_second_rollover_update
before update on public.students for each row
execute function pg_temp.reject_second_rollover_update();

do $$
declare
    source_year uuid := gen_random_uuid();
    next_year uuid := gen_random_uuid();
    existing_section uuid := gen_random_uuid();
    inactive_year uuid := gen_random_uuid();
    inactive_next_year uuid := gen_random_uuid();
    inactive_section uuid := gen_random_uuid();
    first_student uuid := gen_random_uuid();
    second_student uuid := gen_random_uuid();
    serial_base integer;
    first_suffix text;
    second_suffix text;
    outcome jsonb;
begin
    loop
        serial_base := 5000 + floor(random() * 4000)::integer;
        first_suffix := lpad(serial_base::text, 4, '0');
        second_suffix := lpad((serial_base + 1)::text, 4, '0');
        exit when not exists (select 1 from public.students
            where split_part(stud_id, '-', 2) in (first_suffix, second_suffix));
    end loop;
    insert into public.school_years(id, name, start_date, end_date) values
      (source_year, '2018-2019 Atomicity Fixture', '2018-06-01', '2019-03-31'),
      (next_year, '2019-2020 Atomicity Fixture', '2019-06-01', '2020-03-31'),
      (inactive_year, '2016-2017 Inactive Fixture', '2016-06-01', '2017-03-31'),
      (inactive_next_year, '2017-2018 Inactive Fixture', '2017-06-01', '2018-03-31');
    insert into public.sections(section_id, grade_level, section_name, school_year_id)
      values (existing_section, 'Grade 1', 'Atomicity Fixture', source_year),
             (inactive_section, 'Grade 1', 'Inactive Fixture', inactive_year);
    insert into public.students(student_id, stud_id, first_name, last_name,
                                section_id, school_year_id, status) values
      (first_student, '1-' || first_suffix, 'First', 'Fixture', existing_section, source_year, 'active'),
      (second_student, '1-' || second_suffix, 'Second', 'Fixture', existing_section, source_year, 'active');
    insert into public.students(student_id, stud_id, first_name, last_name,
                                section_id, school_year_id, status)
      values (gen_random_uuid(), '1-0999', 'Inactive', 'Fixture',
              inactive_section, inactive_year, 'inactive');

    begin
        outcome := student_rollover_private.perform(source_year, 'manual', null);
        raise exception 'Expected synthetic failure was not raised: %', outcome;
    exception when others then
        if sqlerrm <> 'Synthetic second-row failure' then raise; end if;
    end;
    if not exists (select 1 from public.students where student_id = first_student
                   and stud_id = '1-' || first_suffix and school_year_id = source_year
                   and section_id = existing_section)
       or not exists (select 1 from public.students where student_id = second_student
                      and stud_id = '1-' || second_suffix and school_year_id = source_year
                      and section_id = existing_section)
       or exists (select 1 from public.student_id_rollovers where school_year_id = source_year)
       or exists (select 1 from public.student_id_rollover_changes where school_year_id = source_year)
       or exists (select 1 from public.student_id_rollover_qr_queue where school_year_id = source_year) then
        raise exception 'Failed batch left partial student or history changes';
    end if;
    drop trigger reject_second_rollover_update on public.students;
    if student_rollover_private.run_due() <> 1 then
        raise exception 'Scheduled runner did not complete exactly one due year';
    end if;
    if (select processed_count from public.student_id_rollovers
        where school_year_id = source_year) <> 2 then
        raise exception 'Scheduled runner processed the wrong number of students';
    end if;
    if exists (select 1 from public.student_id_rollovers
               where school_year_id = inactive_year) then
        raise exception 'Scheduled runner processed an inactive-only year';
    end if;
    if (select count(*) from public.students
        where student_id in (first_student, second_student)
          and section_id = existing_section and school_year_id = next_year
          and stud_id like '2-%') <> 2 then
        raise exception 'Scheduled runner changed section assignments';
    end if;
    outcome := student_rollover_private.perform(source_year, 'manual', null);
    if outcome->>'result' <> 'already_completed' then
        raise exception 'Manual retry after automatic run was not idempotent: %', outcome;
    end if;
    if (select execution_mode from public.student_id_rollovers where school_year_id = source_year)
       <> 'automatic' then
        raise exception 'Automatic execution was not recorded';
    end if;
    raise notice 'Atomic rollback, automatic execution, and manual retry passed.';
end $$;

rollback;
