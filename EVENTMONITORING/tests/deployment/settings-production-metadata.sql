-- Read-only verification of the settings migration and SMS override.
select jsonb_build_object(
    'tables', jsonb_build_object(
        'system', to_regclass('public.system_settings')::text,
        'gate', to_regclass('public.gate_settings')::text,
        'event', to_regclass('public.event_settings')::text
    ),
    'system_rows', (select jsonb_agg(jsonb_build_object('key', key, 'value', value)
        order by key) from public.system_settings),
    'gate_rows', (select jsonb_agg(jsonb_build_object('key', key, 'value', value)
        order by key) from public.gate_settings),
    'event_rows', (select jsonb_agg(jsonb_build_object('key', key, 'value', value)
        order by key) from public.event_settings),
    'effective_gate_sms', (
        select s.value = 'true' and g.value = 'true'
        from public.system_settings s cross join public.gate_settings g
        where s.key = 'sms_enabled' and g.key = 'sms_enabled'
    ),
    'effective_event_sms', (
        select s.value = 'true' and e.value = 'true'
        from public.system_settings s cross join public.event_settings e
        where s.key = 'sms_enabled' and e.key = 'sms_enabled'
    ),
    'policies', (
        select jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname,
            'command', cmd, 'permissive', permissive, 'roles', roles)
            order by tablename, cmd, policyname)
        from pg_policies where schemaname = 'public'
            and tablename in ('system_settings', 'gate_settings', 'event_settings')
    ),
    'rls_enabled', (
        select jsonb_object_agg(c.relname, c.relrowsecurity)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
            and c.relname in ('system_settings', 'gate_settings', 'event_settings')
    )
) as verification;
