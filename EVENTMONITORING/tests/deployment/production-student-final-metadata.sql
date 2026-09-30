-- Read-only final production metadata verification; no student values returned.
select jsonb_build_object(
  'student_columns', (select count(*) from information_schema.columns
    where table_schema='public' and table_name='students'),
  'rls_enabled', (select relrowsecurity from pg_class
    where oid='public.students'::regclass),
  'policies', (select jsonb_agg(jsonb_build_object('name',policyname,
      'command',cmd,'permissive',permissive,'roles',roles)
      order by policyname) from pg_policies
    where schemaname='public' and tablename='students'),
  'grants', (select jsonb_agg(jsonb_build_object(
      'role',rolname,'select',has_table_privilege(oid,'public.students','SELECT'),
      'insert',has_table_privilege(oid,'public.students','INSERT'),
      'update',has_table_privilege(oid,'public.students','UPDATE'),
      'delete',has_table_privilege(oid,'public.students','DELETE'),
      'truncate',has_table_privilege(oid,'public.students','TRUNCATE')) order by rolname)
    from pg_roles where rolname in ('anon','authenticated','service_role')),
  'authenticated_insert_columns', (select jsonb_agg(column_name order by column_name)
    from information_schema.column_privileges where table_schema='public'
      and table_name='students' and grantee='authenticated'
      and privilege_type='INSERT'),
  'authenticated_update_columns', (select jsonb_agg(column_name order by column_name)
    from information_schema.column_privileges where table_schema='public'
      and table_name='students' and grantee='authenticated'
      and privilege_type='UPDATE'),
  'grade_constraints', (select jsonb_agg(jsonb_build_object('name',conname,
      'definition',pg_get_constraintdef(oid)) order by conname)
    from pg_constraint where conrelid='public.students'::regclass
      and conname in ('students_current_grade_level_valid',
                      'students_current_grade_matches_id')),
  'grade_insert_trigger', (select pg_get_triggerdef(oid) from pg_trigger
    where tgrelid='public.students'::regclass
      and tgname='students_initialize_current_grade'),
  'rollover_rls_enabled', (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.student_id_rollovers'::regclass,
      'public.student_id_rollover_changes'::regclass,
      'public.student_id_rollover_qr_queue'::regclass)),
  'normal_admin_rollover_execute_grant', has_function_privilege(
      'authenticated','public.run_student_id_rollover(uuid)','EXECUTE'),
  'anon_rollover_execute_grant', has_function_privilege(
      'anon','public.run_student_id_rollover(uuid)','EXECUTE'),
  'private_schema_authenticated_usage', has_schema_privilege(
      'authenticated','student_rollover_private','USAGE'),
  'cron_jobs', (select jsonb_agg(jsonb_build_object('name',jobname,
      'schedule',schedule,'command',command,'active',active))
    from cron.job where jobname='student-id-rollover-daily'),
  'admin_profiles', (select count(*) from public.admins),
  'temporary_admin_profiles', (select count(*) from public.admins
    where email like 'codex-browser-%@example.com'),
  'sms_enabled', (select value from public.system_settings where key='sms_enabled'),
  'anti_spoof_enabled', (select value from public.system_settings
    where key='anti_spoof_enabled')
) as final_metadata;
