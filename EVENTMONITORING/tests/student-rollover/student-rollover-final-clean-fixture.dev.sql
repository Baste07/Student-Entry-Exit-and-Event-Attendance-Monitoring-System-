-- DEVELOPMENT ONLY. Assertions against rows seeded before the exact migration.
-- Rollover execution is rolled back so the pre-install fixture remains inspectable.
begin;
do $$ declare
  y uuid := '00000000-0000-4000-8000-000000009000';
  next_y uuid := '00000000-0000-4000-8000-000000009001';
  preview jsonb; outcome jsonb;
begin
  if (select count(*) from public.students where first_name='CleanRolloverFixture') <> 15
    or (select count(*) from public.students where first_name='CleanRolloverFixture'
      and current_grade_level=(case when split_part(stud_id,'-',1)='K' then 'Kinder'
        else 'Grade '||split_part(stud_id,'-',1) end)) <> 15
    or (select value from public.system_settings where key='school_year_end_month_day') <> '03-25'
  then raise exception 'Exact migration backfill/default failed'; end if;
  if exists (select 1 from public.students s join public.sections sec using(section_id)
    where s.stud_id in ('1-0016','1-0018','1-0034')
      and (s.current_grade_level <> 'Grade 1' or sec.grade_level = 'Grade 1'))
  then raise exception 'Section mismatch overrode student ID grade'; end if;
  if (select count(*) from public.students where stud_id in
    ('1-0016','1-0018','1-0034') and current_grade_level='Grade 1') <> 3
  then raise exception 'Three dummy-student backfill failed'; end if;
  if (select current_grade_level from public.students where stud_id='K-0002') <> 'Kinder'
    or (select current_grade_level from public.students where stud_id='2-0099') <> 'Grade 2'
  then raise exception 'K/Grade 2 backfill failed'; end if;
  if exists (select 1 from generate_series(3,10) g
    where not exists (select 1 from public.students
      where stud_id like g::text||'-%' and current_grade_level='Grade '||g::text))
  then raise exception 'Numeric 3-10 backfill failed'; end if;
  if not exists (select 1 from pg_constraint where conrelid='public.students'::regclass
    and conname='students_current_grade_matches_id')
  then raise exception 'Grade/Student ID consistency constraint absent'; end if;
  begin
    update public.students set current_grade_level='Grade 4' where stud_id='1-0016';
    raise exception 'Grade/Student ID inconsistency was accepted';
  exception when check_violation then null; end;
  begin
    update public.students set current_grade_level=null where stud_id='1-0016';
    raise exception 'NULL academic grade was accepted for a valid Student ID';
  exception when check_violation then null; end;
  begin
    update public.students set current_grade_level=null where stud_id='1-0001';
    raise exception '1-0001 with NULL grade was accepted';
  exception when check_violation then null; end;
  begin
    update public.students set current_grade_level='Grade 2' where stud_id='1-0001';
    raise exception '1-0001 with Grade 2 was accepted';
  exception when check_violation then null; end;
  update public.students set current_grade_level='Grade 1' where stud_id='1-0001';
  if not found then raise exception '1-0001 with Grade 1 was not accepted'; end if;
  insert into public.students(student_id,stud_id,first_name,last_name,
      current_grade_level,section_id,school_year_id,status)
  values ('00000000-0000-4000-8000-000000009003','K-0001',
      'CleanGradeAcceptanceFixture','Kinder','Kinder',
      '00000000-0000-4000-8000-000000009100',y,'active');
  if (select current_grade_level from public.students where stud_id='K-0001') <> 'Kinder'
  then raise exception 'K-0001 with Kinder was not accepted'; end if;
  delete from public.students where stud_id='K-0001'
    and first_name='CleanGradeAcceptanceFixture';
  if not found then raise exception 'K-0001 acceptance fixture cleanup failed'; end if;
  preview:=student_rollover_private.summary(y);
  if (preview->>'ready')::integer <> 13
    or (preview->>'highest_grade')::integer <> 1
    or (preview->>'inactive')::integer <> 1
    or (preview->>'grade_mismatch')::integer <> 0
    or not (preview->>'can_run')::boolean
  then raise exception 'Preview misclassified clean fixture: %',preview; end if;
  if (select count(*) from public.students where first_name='CleanRolloverFixture'
    and current_grade_level='Grade 1' and status='active') <> 4
  then raise exception 'Pre-rollover Event Grade 1 targeting failed'; end if;

  create temporary table clean_identity_snapshot on commit drop as
    select student_id, stud_id, section_id, school_year_id
    from public.students where first_name='CleanRolloverFixture';
  outcome:=student_rollover_private.perform(y,'manual',null);
  if outcome->>'result'<>'completed' or (outcome->>'processed')::integer<>13
  then raise exception 'Manual rollover failed: %',outcome; end if;
  if exists(select 1 from clean_identity_snapshot old join public.students s using(student_id)
    where s.section_id is distinct from old.section_id)
  then raise exception 'Rollover changed persistent section'; end if;
  if not exists(select 1 from public.students
    where stud_id='1-0002' and current_grade_level='Grade 1' and school_year_id=next_y)
    or not exists(select 1 from public.students
      where stud_id='2-0001' and current_grade_level='Grade 2' and school_year_id=next_y)
    or not exists(select 1 from public.students
      where stud_id='3-0099' and current_grade_level='Grade 3' and school_year_id=next_y)
  then raise exception 'K/1/2 progression failed'; end if;
  if (select count(*) from public.students where first_name='CleanRolloverFixture'
      and current_grade_level='Grade 2' and status='active')<>4
    or (select count(*) from public.students where first_name='CleanRolloverFixture'
      and current_grade_level='Grade 1' and status='active')<>1
  then raise exception 'Post-rollover Event/analytics grade filtering failed'; end if;
  if not exists(select 1 from public.student_guardians g join public.students s using(student_id)
    where s.stud_id='2-0001')
    or not exists(select 1 from public.event_participants p join public.students s using(student_id)
    where s.stud_id='2-0001')
    or not exists(select 1 from public.event_attendance a join public.students s using(student_id)
    where s.stud_id='2-0001')
    or not exists(select 1 from public.entry_exit_logs l join public.students s using(student_id)
    where s.stud_id='2-0001')
  then raise exception 'UUID-linked guardian/event/gate records disconnected'; end if;
  if (select count(*) from public.student_id_rollover_qr_queue where school_year_id=y)<>14
    or (select count(*) from public.student_id_rollover_changes where school_year_id=y)<>13
    or not public.student_qr_uuid_required()
  then raise exception 'History or UUID QR reissue queue failed'; end if;
  outcome:=student_rollover_private.perform(y,'manual',null);
  if outcome->>'result'<>'already_completed'
    or (select count(*) from public.student_id_rollovers where school_year_id=y)<>1
  then raise exception 'Exactly-once retry failed'; end if;
  raise notice 'PASS: exact-file backfill, grade mismatch, manual rollover, links, QR, exactly once';
end $$;
rollback;
