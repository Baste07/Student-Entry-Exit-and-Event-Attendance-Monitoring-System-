-- DEVELOPMENT ONLY. Remove only the exact synthetic clean-install fixture.
begin;
do $$ begin
  if (select count(*) from public.students
      where first_name='CleanRolloverFixture' and school_year_id='00000000-0000-4000-8000-000000009000')<>15
    or (select count(*) from public.student_id_rollovers)<>0
    or (select count(*) from public.student_id_rollover_changes)<>0
    or (select count(*) from public.student_id_rollover_qr_queue)<>0
  then raise exception 'Clean-install fixture differs from expected; cleanup stopped'; end if;
end $$;
delete from public.student_guardians where student_id='00000000-0000-4000-8000-000000009011';
delete from public.event_participants where student_id='00000000-0000-4000-8000-000000009011';
delete from public.event_attendance where student_id='00000000-0000-4000-8000-000000009011';
delete from public.entry_exit_logs where student_id='00000000-0000-4000-8000-000000009011';
delete from public.students where first_name='CleanRolloverFixture'
  and school_year_id='00000000-0000-4000-8000-000000009000';
delete from public.sections where school_year_id='00000000-0000-4000-8000-000000009000'
  and section_name like 'Clean %';
delete from public.school_years where id in
  ('00000000-0000-4000-8000-000000009000','00000000-0000-4000-8000-000000009001')
  and name like '%Clean Rollover Fixture';
commit;
