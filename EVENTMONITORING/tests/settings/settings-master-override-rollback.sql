-- Controlled RLS check: Master SMS is ON only inside this transaction.
-- ROLLBACK prevents scanners or other sessions from observing the test value.
begin;
do $$
declare super_id uuid;
begin
    select admin_id into super_id from public.admins
    where admin_level = 'super_admin' and status = 'active' limit 1;
    if super_id is null then raise exception 'No active Super Admin for test'; end if;
    perform set_config('test.super_id', super_id::text, true);
end $$;
set local role authenticated;
do $$
declare changed integer;
declare effective_gate boolean;
declare effective_event boolean;
begin
    perform set_config('request.jwt.claim.sub', current_setting('test.super_id'), true);
    update public.system_settings set value = 'true'
    where key = 'sms_enabled' and value = 'false';
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'Super Admin could not enable Master SMS'; end if;
    select s.value = 'true' and g.value = 'true',
           s.value = 'true' and e.value = 'true'
    into effective_gate, effective_event
    from public.system_settings s
    cross join public.gate_settings g
    cross join public.event_settings e
    where s.key = 'sms_enabled' and g.key = 'sms_enabled' and e.key = 'sms_enabled';
    if not coalesce(effective_gate, false) or not coalesce(effective_event, false) then
        raise exception 'Module SMS preferences did not become effective';
    end if;
end $$;
rollback;
