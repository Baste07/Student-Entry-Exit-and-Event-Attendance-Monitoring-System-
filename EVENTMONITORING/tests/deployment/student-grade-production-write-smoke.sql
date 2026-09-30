-- Controlled Phase 2 production smoke test. Synthetic row and edits roll back.
-- It never invokes the manual or automatic rollover functions.
begin;
do $$
declare v_super uuid; v_normal uuid; v_year uuid; v_section uuid;
        v_serial text; v_student uuid := gen_random_uuid();
begin
  select admin_id into v_super from public.admins
    where admin_level='super_admin' and status='active' limit 1;
  select admin_id into v_normal from public.admins
    where admin_level='admin' and status='active' limit 1;
  select school_year_id,section_id into v_year,v_section
    from public.students order by student_id limit 1;
  select lpad(n::text,4,'0') into v_serial from generate_series(9000,9999) n
    where not exists(select 1 from public.students s
      where s.stud_id in ('1-'||lpad(n::text,4,'0'),
                          '2-'||lpad(n::text,4,'0')))
    order by n limit 1;
  if v_super is null or v_normal is null or v_year is null or v_serial is null
  then raise exception 'Grade smoke fixture preflight failed'; end if;
  perform set_config('grade_smoke.super',v_super::text,true);
  perform set_config('grade_smoke.normal',v_normal::text,true);
  perform set_config('grade_smoke.student',v_student::text,true);
  perform set_config('grade_smoke.serial',v_serial,true);
  perform set_config('grade_smoke.year',v_year::text,true);
  perform set_config('grade_smoke.section',coalesce(v_section::text,''),true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('grade_smoke.super'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
do $$ declare n integer; begin
  insert into public.students(student_id,stud_id,current_grade_level,
      first_name,last_name,section_id,school_year_id,status)
  values(current_setting('grade_smoke.student')::uuid,
      '1-'||current_setting('grade_smoke.serial'),'Grade 1',
      'GradeSmokeFixture','Student',
      nullif(current_setting('grade_smoke.section'),'')::uuid,
      current_setting('grade_smoke.year')::uuid,'active');
  if not exists(select 1 from public.students where
      student_id=current_setting('grade_smoke.student')::uuid
      and current_grade_level='Grade 1')
  then raise exception 'Super Admin grade-aware registration failed'; end if;
  begin
    update public.students set current_grade_level=null
      where student_id=current_setting('grade_smoke.student')::uuid;
    raise exception 'NULL grade edit was accepted';
  exception when check_violation then null; end;
  begin
    update public.students set current_grade_level='Grade 2'
      where student_id=current_setting('grade_smoke.student')::uuid;
    raise exception 'Mismatched grade edit was accepted';
  exception when check_violation then null; end;
  update public.students set stud_id='2-'||current_setting('grade_smoke.serial'),
      current_grade_level='Grade 2'
    where student_id=current_setting('grade_smoke.student')::uuid;
  get diagnostics n=row_count;
  if n<>1 or not exists(select 1 from public.students where
      student_id=current_setting('grade_smoke.student')::uuid
      and stud_id='2-'||current_setting('grade_smoke.serial')
      and current_grade_level='Grade 2'
      and school_year_id=current_setting('grade_smoke.year')::uuid
      and section_id is not distinct from
          nullif(current_setting('grade_smoke.section'),'')::uuid)
  then raise exception 'Super Admin grade-aware edit changed protected identity'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('grade_smoke.normal'),true);
set local role authenticated;
do $$ declare n integer; begin
  update public.students set current_grade_level='Grade 3'
    where student_id=current_setting('grade_smoke.student')::uuid;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Normal Admin modified current grade'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('grade_smoke.super'),true);
set local role authenticated;
do $$ declare n integer; begin
  delete from public.students
    where student_id=current_setting('grade_smoke.student')::uuid;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Super Admin grade fixture deletion failed'; end if;
end $$;
reset role;
rollback;
