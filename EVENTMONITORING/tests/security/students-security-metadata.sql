-- Read-only post-migration verification; development project only.
select jsonb_build_object(
    'policies', (select jsonb_agg(jsonb_build_object('name',policyname,'command',cmd,
                      'permissive',permissive,'roles',roles,'using',qual,'check',with_check)
                      order by policyname) from pg_policies
                 where schemaname='public' and tablename='students'),
    'table_grants', (select jsonb_agg(jsonb_build_object('role',role_name,
                      'select',has_table_privilege(role_name,'public.students','SELECT'),
                      'insert',has_table_privilege(role_name,'public.students','INSERT'),
                      'update',has_table_privilege(role_name,'public.students','UPDATE'),
                      'delete',has_table_privilege(role_name,'public.students','DELETE'),
                      'truncate',has_table_privilege(role_name,'public.students','TRUNCATE')))
                     from (values ('anon'),('authenticated'),('service_role')) r(role_name)),
    'auth_insert_columns', (select jsonb_agg(attname order by attnum)
                     from pg_attribute where attrelid='public.students'::regclass
                       and attnum>0 and not attisdropped
                       and has_column_privilege('authenticated','public.students',attname,'INSERT')),
    'auth_update_columns', (select jsonb_agg(attname order by attnum)
                     from pg_attribute where attrelid='public.students'::regclass
                       and attnum>0 and not attisdropped
                       and has_column_privilege('authenticated','public.students',attname,'UPDATE')),
    'auth_select_columns', (select jsonb_agg(attname order by attnum)
                     from pg_attribute where attrelid='public.students'::regclass
                       and attnum>0 and not attisdropped
                       and has_column_privilege('authenticated','public.students',attname,'SELECT')),
    'rollover_cron_count', (select count(*) from cron.job where jobname='student-id-rollover-daily')
) as result;
