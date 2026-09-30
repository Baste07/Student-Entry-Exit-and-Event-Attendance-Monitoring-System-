-- Development only. Run after the grade-prefix seed and revised migration.
-- The simulated rollover is rolled back.
begin;
do $$
declare preview jsonb; outcome jsonb;
begin
  if (select count(*) from public.students where first_name='GradePrefixFixture')<>7 then
    raise exception 'Grade-prefix fixture missing'; end if;
  if exists (
    select 1 from (values
      ('1-0016','Grade 1','Grade 4','00000000-0000-4000-8000-000000008016'::uuid,'00000000-0000-4000-8000-000000008104'::uuid),
      ('1-0018','Grade 1','Grade 2','00000000-0000-4000-8000-000000008018'::uuid,'00000000-0000-4000-8000-000000008102'::uuid),
      ('1-0034','Grade 1','Grade 6','00000000-0000-4000-8000-000000008034'::uuid,'00000000-0000-4000-8000-000000008106'::uuid),
      ('K-8003','Kinder','Kinder','00000000-0000-4000-8000-000000008003'::uuid,'00000000-0000-4000-8000-000000008100'::uuid),
      ('2-8004','Grade 2','Grade 2','00000000-0000-4000-8000-000000008004'::uuid,'00000000-0000-4000-8000-000000008102'::uuid),
      ('10-8005','Grade 10','Grade 10','00000000-0000-4000-8000-000000008005'::uuid,'00000000-0000-4000-8000-000000008110'::uuid),
      ('1-8006','Grade 1','Grade 4','00000000-0000-4000-8000-000000008006'::uuid,'00000000-0000-4000-8000-000000008104'::uuid)
    ) expected(stud_id,student_grade,section_grade,student_uuid,section_uuid)
    left join public.students s on s.stud_id=expected.stud_id
    left join public.sections sec on sec.section_id=s.section_id
    where s.student_id is distinct from expected.student_uuid
       or s.current_grade_level is distinct from expected.student_grade
       or s.section_id is distinct from expected.section_uuid
       or sec.grade_level is distinct from expected.section_grade
  ) then raise exception 'Backfill grade, UUID, or section mismatch'; end if;
  -- This is the predicate used by Event grade targeting: section grade must
  -- not pull these students into Grade 4/2/6 before rollover.
  if (select count(*) from public.students where first_name='GradePrefixFixture'
      and status='active' and current_grade_level='Grade 1')<>3
     or (select count(*) from public.students where first_name='GradePrefixFixture'
      and status='active' and current_grade_level='Grade 4')<>0 then
    raise exception 'Event grade targeting follows section metadata'; end if;
  preview:=student_rollover_private.summary('00000000-0000-4000-8000-000000008000');
  if (preview->>'ready')::int<>5 or (preview->>'highest_grade')::int<>1
     or (preview->>'inactive')::int<>1 or (preview->>'grade_mismatch')::int<>0
     or not (preview->>'can_run')::boolean then
    raise exception 'Section mismatch incorrectly blocks rollover: %',preview; end if;
  begin
    update public.students set current_grade_level='Grade 4' where stud_id='1-0016';
    raise exception 'Conflicting Student ID/current grade was accepted';
  exception when check_violation then null; end;
  outcome:=student_rollover_private.perform('00000000-0000-4000-8000-000000008000','manual',null);
  if outcome->>'result'<>'completed' or (outcome->>'processed')::int<>5 then
    raise exception 'Rollover with mismatched section failed: %',outcome; end if;
  if not exists(select 1 from public.students
      where student_id='00000000-0000-4000-8000-000000008016'
        and stud_id='2-0016' and current_grade_level='Grade 2'
        and section_id='00000000-0000-4000-8000-000000008104'
        and school_year_id='00000000-0000-4000-8000-000000008001') then
    raise exception 'Rollover failed to preserve UUID/section or advance grade'; end if;
  if (select count(*) from public.students where first_name='GradePrefixFixture'
      and status='active' and current_grade_level='Grade 2')<>3
     or (select count(*) from public.students where first_name='GradePrefixFixture'
      and status='active' and current_grade_level='Grade 1')<>1 then
    raise exception 'Event Grade 2 targeting did not follow rollover'; end if;
end $$;
rollback;
