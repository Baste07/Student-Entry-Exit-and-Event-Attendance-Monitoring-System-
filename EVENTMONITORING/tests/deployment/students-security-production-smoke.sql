-- Controlled production permission smoke test. All changes roll back.
-- Run only after 20260927_students_security.sql and before the grade migration.
begin;
do $$
declare
  v_normal uuid;
  v_super uuid;
  v_student uuid;
  v_year uuid;
  v_section uuid;
  v_new uuid := gen_random_uuid();
  v_id text;
begin
  select admin_id into v_normal from public.admins
    where admin_level='admin' and status='active' limit 1;
  select admin_id into v_super from public.admins
    where admin_level='super_admin' and status='active' limit 1;
  select student_id,school_year_id,section_id into v_student,v_year,v_section
    from public.students order by student_id limit 1;
  select '1-' || lpad(n::text,4,'0') into v_id
    from generate_series(9000,9999) n
   where not exists(select 1 from public.students s
                    where s.stud_id='1-' || lpad(n::text,4,'0'))
   order by n limit 1;
  if v_normal is null or v_super is null or v_student is null or v_id is null then
    raise exception 'Required production test identities or free Student ID absent';
  end if;
  perform set_config('deployment.normal',v_normal::text,true);
  perform set_config('deployment.super',v_super::text,true);
  perform set_config('deployment.student',v_student::text,true);
  perform set_config('deployment.year',v_year::text,true);
  perform set_config('deployment.section',coalesce(v_section::text,''),true);
  perform set_config('deployment.new',v_new::text,true);
  perform set_config('deployment.stud_id',v_id,true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('deployment.normal'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
do $$ declare n integer; begin
  select count(*) into n from public.students
    where student_id=current_setting('deployment.student')::uuid;
  if n<>1 then raise exception 'Normal Admin student SELECT failed'; end if;
  update public.students set first_name='Denied'
    where student_id=current_setting('deployment.student')::uuid;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Normal Admin edited student'; end if;
  delete from public.students
    where student_id=current_setting('deployment.student')::uuid;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Normal Admin deleted student'; end if;
  begin
    insert into public.students(student_id,stud_id,first_name,last_name,status)
    values(gen_random_uuid(),current_setting('deployment.stud_id'),
           'Denied','NormalAdmin','active');
    raise exception 'Normal Admin inserted student';
  exception when insufficient_privilege then null; end;
  begin
    update public.students set student_id=gen_random_uuid()
      where student_id=current_setting('deployment.student')::uuid;
    raise exception 'Browser UUID update privilege remains';
  exception when insufficient_privilege then null; end;
  begin
    update public.students set facial_dataset_path='Denied'
      where student_id=current_setting('deployment.student')::uuid;
    raise exception 'Browser face-path update privilege remains';
  exception when insufficient_privilege then null; end;
  begin
    truncate public.students;
    raise exception 'Authenticated TRUNCATE privilege remains';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- The change is uncommitted and invisible to concurrent sessions; rollback
-- restores the Admin profile after the suspended-identity check.
update public.admins set status='suspended'
 where admin_id=current_setting('deployment.normal')::uuid;
select set_config('request.jwt.claim.sub',current_setting('deployment.normal'),true);
set local role authenticated;
do $$ declare n integer; begin
  update public.students set first_name='DeniedSuspended'
    where student_id=current_setting('deployment.student')::uuid;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Suspended Admin edited student'; end if;
  begin
    insert into public.students(student_id,stud_id,first_name,last_name,status)
    values(gen_random_uuid(),current_setting('deployment.stud_id'),
           'Denied','SuspendedAdmin','active');
    raise exception 'Suspended Admin inserted student';
  exception when insufficient_privilege then null; end;
  delete from public.students
    where student_id=current_setting('deployment.student')::uuid;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Suspended Admin deleted student'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('deployment.super'),true);
set local role authenticated;
do $$ declare n integer; begin
  insert into public.students(student_id,stud_id,first_name,last_name,
      suffix,birth_date,gender,section_id,school_year_id,address,email,
      status,created_at,updated_at)
  values(current_setting('deployment.new')::uuid,
      current_setting('deployment.stud_id'),'DeploymentFixture','Student',
      'Jr','2010-01-01','male',nullif(current_setting('deployment.section'),'')::uuid,
      current_setting('deployment.year')::uuid,'Fixture address',
      'deployment-fixture@example.invalid','active',now(),now());
  if not exists(select 1 from public.students
      where student_id=current_setting('deployment.new')::uuid)
  then raise exception 'Super Admin registration/import insert failed'; end if;
  update public.students set first_name='EditedFixture',status='inactive',
      address='Updated fixture address',updated_at=now()
    where student_id=current_setting('deployment.new')::uuid;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Super Admin edit/status failed'; end if;
  update public.students set status='active'
    where student_id=current_setting('deployment.new')::uuid;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Super Admin reactivate failed'; end if;
  begin
    update public.students set student_id=gen_random_uuid()
      where student_id=current_setting('deployment.new')::uuid;
    raise exception 'Super Admin browser UUID update privilege remains';
  exception when insufficient_privilege then null; end;
  delete from public.students
    where student_id=current_setting('deployment.new')::uuid;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Super Admin deletion failed'; end if;
end $$;
reset role;

set local role service_role;
do $$ declare n integer; begin
  update public.students set facial_dataset_path=facial_dataset_path,
      face_embedding=face_embedding,
      face_embedding_fingerprint=face_embedding_fingerprint
    where student_id=current_setting('deployment.student')::uuid;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Service role face metadata update failed'; end if;
end $$;
reset role;
rollback;
