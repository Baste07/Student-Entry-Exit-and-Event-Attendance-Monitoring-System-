-- Read-only production snapshot. Contains student UUIDs, display IDs, and
-- academic references, but no face data, passwords, keys, or private settings.
select jsonb_build_object(
  'captured_at_utc', now(),
  'schema', (select jsonb_agg(jsonb_build_object(
      'name',column_name,'type',data_type,'nullable',is_nullable,
      'default',column_default) order by ordinal_position)
    from information_schema.columns
    where table_schema='public' and table_name='students'),
  'constraints', (select coalesce(jsonb_agg(jsonb_build_object(
      'name',conname,'definition',pg_get_constraintdef(oid)) order by conname), '[]'::jsonb)
    from pg_constraint where conrelid='public.students'::regclass),
  'indexes', (select coalesce(jsonb_agg(jsonb_build_object(
      'name',indexname,'definition',indexdef) order by indexname), '[]'::jsonb)
    from pg_indexes where schemaname='public' and tablename='students'),
  'triggers', (select coalesce(jsonb_agg(jsonb_build_object(
      'name',tgname,'definition',pg_get_triggerdef(oid)) order by tgname), '[]'::jsonb)
    from pg_trigger where tgrelid='public.students'::regclass and not tgisinternal),
  'students', (select jsonb_agg(jsonb_build_object(
      'student_id',student_id,'stud_id',stud_id,'school_year_id',school_year_id,
      'section_id',section_id,'status',status) order by student_id)
    from public.students),
  'policies', (select coalesce(jsonb_agg(jsonb_build_object(
      'name',policyname,'command',cmd,'roles',roles,'permissive',permissive,
      'using',qual,'with_check',with_check) order by policyname), '[]'::jsonb)
    from pg_policies where schemaname='public' and tablename='students'),
  'table_grants', (select jsonb_agg(jsonb_build_object(
      'role',rolname,'select',has_table_privilege(oid,'public.students','SELECT'),
      'insert',has_table_privilege(oid,'public.students','INSERT'),
      'update',has_table_privilege(oid,'public.students','UPDATE'),
      'delete',has_table_privilege(oid,'public.students','DELETE'),
      'truncate',has_table_privilege(oid,'public.students','TRUNCATE'),
      'references',has_table_privilege(oid,'public.students','REFERENCES'),
      'trigger',has_table_privilege(oid,'public.students','TRIGGER')) order by rolname)
    from pg_roles where rolname in ('anon','authenticated','service_role')),
  'column_grants', (select jsonb_agg(jsonb_build_object(
      'column',a.attname,'role',r.rolname,
      'select',has_column_privilege(r.oid,'public.students',a.attname,'SELECT'),
      'insert',has_column_privilege(r.oid,'public.students',a.attname,'INSERT'),
      'update',has_column_privilege(r.oid,'public.students',a.attname,'UPDATE'))
      order by a.attnum,r.rolname)
    from pg_attribute a cross join pg_roles r
    where a.attrelid='public.students'::regclass and a.attnum>0
      and not a.attisdropped and r.rolname in ('anon','authenticated','service_role')),
  'cron_extension_installed', exists(select 1 from pg_extension where extname='pg_cron'),
  'cron_relation_exists', to_regclass('cron.job') is not null,
  'relevant_settings', (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
    from public.system_settings where key in
      ('sms_enabled','anti_spoof_enabled','school_year_end_month_day')),
  'link_counts', jsonb_build_object(
      'student_guardians',(select count(*) from public.student_guardians),
      'event_participants',(select count(*) from public.event_participants),
      'event_attendance',(select count(*) from public.event_attendance),
      'entry_exit_logs',(select count(*) from public.entry_exit_logs))
) as snapshot;
