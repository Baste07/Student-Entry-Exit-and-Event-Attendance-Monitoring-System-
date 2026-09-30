-- Read-only Phase 1 gate. A failure must stop Phase 2 deployment.
do $$ begin
  if (select count(*) from public.students) <> 40
     or exists(select 1 from public.students
       where first_name='DeploymentFixture')
     or (select count(*) from public.admins
       where admin_level='admin' and status='active') <> 1
     or (select count(*) from public.admins
       where admin_level='super_admin' and status='active') <> 2
  then raise exception 'Phase 1 row/admin baseline changed'; end if;
  if not (select relrowsecurity from pg_class where oid='public.students'::regclass)
     or (select count(*) from pg_policies
       where schemaname='public' and tablename='students') <> 7
     or exists(select 1 from pg_policies
       where schemaname='public' and tablename='students'
         and policyname like 'Enable % for authenticated users')
  then raise exception 'Phase 1 RLS policy set differs'; end if;
  if has_table_privilege('anon','public.students','SELECT')
     or has_table_privilege('anon','public.students','INSERT')
     or has_table_privilege('anon','public.students','UPDATE')
     or has_table_privilege('anon','public.students','DELETE')
     or has_table_privilege('authenticated','public.students','TRUNCATE')
     or has_table_privilege('authenticated','public.students','INSERT')
     or has_table_privilege('authenticated','public.students','UPDATE')
     or not has_table_privilege('authenticated','public.students','SELECT')
     or not has_table_privilege('authenticated','public.students','DELETE')
     or has_column_privilege('authenticated','public.students','student_id','UPDATE')
     or has_column_privilege('authenticated','public.students','facial_dataset_path','UPDATE')
     or has_column_privilege('authenticated','public.students','face_embedding','UPDATE')
     or has_column_privilege('authenticated','public.students','face_embedding_fingerprint','UPDATE')
     or has_column_privilege('authenticated','public.students','profile_picture','UPDATE')
     or not has_table_privilege('service_role','public.students','UPDATE')
  then raise exception 'Phase 1 grants differ'; end if;
  if exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='students'
      and column_name='current_grade_level')
  then raise exception 'Rollover migration installed before Phase 1 gate'; end if;
end $$;
select jsonb_build_object('phase_1_gate','passed',
  'students',(select count(*) from public.students),
  'policies',(select count(*) from pg_policies
    where schemaname='public' and tablename='students')) as result;
