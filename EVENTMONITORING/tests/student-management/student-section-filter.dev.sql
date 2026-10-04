-- Development-only integration check. Run against ehyqvyglirirktfmdezq.
-- The transaction always rolls back; no school year or section fixture persists.
begin;
set local statement_timeout = '10s';

insert into public.school_years (id, name, start_date, end_date, is_active)
values
  ('00000000-0000-4000-8000-000000000101', 'Codex Section Filter Year A', '2098-01-01', '2098-12-31', false),
  ('00000000-0000-4000-8000-000000000102', 'Codex Section Filter Year B', '2099-01-01', '2099-12-31', false);

insert into public.sections (section_id, grade_level, section_name, school_year_id)
values
  ('00000000-0000-4000-8000-000000000111', 'Grade 1', 'Fixture One', '00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000112', 'Grade 2', 'Fixture Two', '00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000113', 'Grade 10', 'Fixture Ten', '00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000114', 'Grade 1', 'Fixture Old Year', '00000000-0000-4000-8000-000000000102');

do $$
declare
  v_year uuid := '00000000-0000-4000-8000-000000000101';
begin
  if (select count(*) from public.sections where school_year_id = v_year and grade_level = 'Grade 1') <> 1
     or (select count(*) from public.sections where school_year_id = v_year and grade_level = 'Grade 2') <> 1
     or (select count(*) from public.sections where school_year_id = v_year and grade_level = 'Grade 10') <> 1
     or (select count(*) from public.sections where school_year_id = v_year and section_name = 'Fixture Old Year') <> 0 then
    raise exception 'Grade/year section filtering returned an unexpected fixture row';
  end if;
end $$;

rollback;
