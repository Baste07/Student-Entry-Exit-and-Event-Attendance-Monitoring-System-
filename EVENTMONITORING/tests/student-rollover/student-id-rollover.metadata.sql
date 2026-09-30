-- Read-only metadata and post-test cleanliness check for the development project.
select jsonb_build_object(
  'rollover_policies', (select jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', policyname, 'command', cmd,
      'roles', roles, 'permissive', permissive) order by tablename, policyname)
    from pg_policies where schemaname = 'public'
      and tablename in ('student_id_rollovers', 'student_id_rollover_changes',
                        'student_id_rollover_qr_queue', 'system_settings')),
  'rollover_table_grants', (select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'role', r.rolname,
      'select', has_table_privilege(r.oid, c.oid, 'SELECT'),
      'insert', has_table_privilege(r.oid, c.oid, 'INSERT'),
      'update', has_table_privilege(r.oid, c.oid, 'UPDATE'),
      'delete', has_table_privilege(r.oid, c.oid, 'DELETE'))
      order by c.relname, r.rolname)
    from pg_class c cross join pg_roles r
    where c.relnamespace = 'public'::regnamespace
      and c.relname in ('student_id_rollovers', 'student_id_rollover_changes',
                        'student_id_rollover_qr_queue')
      and r.rolname in ('anon', 'authenticated', 'service_role')),
  'rpc_execute', (select jsonb_agg(jsonb_build_object(
      'name', p.proname, 'role', r.rolname,
      'allowed', has_function_privilege(r.oid, p.oid, 'EXECUTE'))
      order by p.proname, r.rolname)
    from pg_proc p cross join pg_roles r
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('preview_student_id_rollover', 'run_student_id_rollover',
                        'student_qr_uuid_required', 'mark_student_rollover_qr_reissued')
      and r.rolname in ('anon', 'authenticated', 'service_role')),
  'private_schema_access', (select jsonb_agg(jsonb_build_object(
      'role', rolname, 'usage', has_schema_privilege(oid, 'student_rollover_private', 'USAGE'))
      order by rolname)
    from pg_roles where rolname in ('anon', 'authenticated', 'service_role')),
  'plan_references_sections', position('public.sections' in
      pg_get_functiondef('student_rollover_private.plan(uuid,uuid)'::regprocedure)) > 0,
  'plan_has_section_blocker', position('awaiting_section' in
      pg_get_functiondef('student_rollover_private.plan(uuid,uuid)'::regprocedure)) > 0,
  'perform_updates_section_id', position('set section_id' in
      pg_get_functiondef('student_rollover_private.perform(uuid,text,uuid)'::regprocedure)) > 0,
  'cron_jobs', (select jsonb_agg(jsonb_build_object(
      'name', jobname, 'schedule', schedule, 'active', active)
      order by jobname) from cron.job where jobname = 'student-id-rollover-daily'),
  'end_setting', (select value from public.system_settings
      where key = 'school_year_end_month_day'),
  'fixture_students_remaining', (select count(*) from public.students),
  'rollover_history_remaining', (select count(*) from public.student_id_rollovers),
  'qr_queue_remaining', (select count(*) from public.student_id_rollover_qr_queue)
) as verification;
