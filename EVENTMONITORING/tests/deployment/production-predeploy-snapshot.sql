-- Read-only production reference snapshot. Never select admins.password.
select jsonb_build_object(
    'project_ref', 'hgdqarcdfycdesavwrvq',
    'captured_at', now(),
    'admin_profiles', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'admin_id', admin_id, 'email', email, 'admin_name', admin_name,
            'admin_level', admin_level, 'status', status, 'faculty', faculty,
            'created_at', created_at, 'updated_at', updated_at
        ) order by admin_id), '[]'::jsonb) from public.admins
    ),
    'admins_policies', (
        select coalesce(jsonb_agg(to_jsonb(p) order by p.policyname), '[]'::jsonb)
        from pg_policies p where p.schemaname = 'public' and p.tablename = 'admins'
    ),
    'admins_acl', (
        select jsonb_build_object('owner', pg_get_userbyid(c.relowner),
            'table_acl', c.relacl::text,
            'column_acl', (
                select coalesce(jsonb_agg(jsonb_build_object('column', a.attname,
                    'acl', a.attacl::text) order by a.attnum), '[]'::jsonb)
                from pg_attribute a where a.attrelid = c.oid
                    and a.attnum > 0 and not a.attisdropped
            ))
        from pg_class c where c.oid = 'public.admins'::regclass
    ),
    'admins_constraints', (
        select coalesce(jsonb_agg(jsonb_build_object('name', conname,
            'definition', pg_get_constraintdef(oid)) order by conname), '[]'::jsonb)
        from pg_constraint where conrelid = 'public.admins'::regclass
    ),
    'system_settings', (
        select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value)
            order by key), '[]'::jsonb) from public.system_settings
    ),
    'settings_columns', (
        select coalesce(jsonb_agg(jsonb_build_object('table', table_name,
            'column', column_name, 'type', data_type, 'nullable', is_nullable)
            order by table_name, ordinal_position), '[]'::jsonb)
        from information_schema.columns where table_schema = 'public'
            and table_name in ('system_settings', 'gate_settings', 'event_settings')
    ),
    'settings_policies', (
        select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb)
        from pg_policies p where p.schemaname = 'public'
            and p.tablename in ('system_settings', 'gate_settings', 'event_settings')
    ),
    'settings_constraints', (
        select coalesce(jsonb_agg(jsonb_build_object('table', c.relname,
            'name', con.conname, 'definition', pg_get_constraintdef(con.oid))
            order by c.relname, con.conname), '[]'::jsonb)
        from pg_constraint con join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
            and c.relname in ('system_settings', 'gate_settings', 'event_settings')
    )
) as snapshot;
