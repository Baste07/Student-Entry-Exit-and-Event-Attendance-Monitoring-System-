-- Read-only verification after the admin-security migration.
select jsonb_build_object(
    'policies', (
        select coalesce(jsonb_agg(jsonb_build_object('name', policyname,
            'command', cmd, 'roles', roles, 'using', qual,
            'with_check', with_check) order by policyname), '[]'::jsonb)
        from pg_policies where schemaname = 'public' and tablename = 'admins'
    ),
    'authenticated_select_columns', (
        select coalesce(jsonb_agg(attname order by attnum), '[]'::jsonb)
        from pg_attribute where attrelid = 'public.admins'::regclass
            and attnum > 0 and not attisdropped
            and has_column_privilege('authenticated', 'public.admins', attname, 'SELECT')
    ),
    'authenticated_update_columns', (
        select coalesce(jsonb_agg(attname order by attnum), '[]'::jsonb)
        from pg_attribute where attrelid = 'public.admins'::regclass
            and attnum > 0 and not attisdropped
            and has_column_privilege('authenticated', 'public.admins', attname, 'UPDATE')
    ),
    'authenticated_insert', has_table_privilege('authenticated', 'public.admins', 'INSERT'),
    'authenticated_delete', has_table_privilege('authenticated', 'public.admins', 'DELETE'),
    'authenticated_truncate', has_table_privilege('authenticated', 'public.admins', 'TRUNCATE'),
    'anon_truncate', has_table_privilege('anon', 'public.admins', 'TRUNCATE'),
    'authenticated_password_select', has_column_privilege('authenticated', 'public.admins', 'password', 'SELECT'),
    'authenticated_password_update', has_column_privilege('authenticated', 'public.admins', 'password', 'UPDATE'),
    'service_insert', has_table_privilege('service_role', 'public.admins', 'INSERT'),
    'service_delete', has_table_privilege('service_role', 'public.admins', 'DELETE'),
    'rls_enabled', (select relrowsecurity from pg_class where oid = 'public.admins'::regclass)
) as verification;
