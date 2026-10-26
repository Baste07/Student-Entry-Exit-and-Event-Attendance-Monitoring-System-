-- Reviewed against the production FK catalog. Installs code only; deletes no data.
begin;

-- Preserve registration audit identity after removing its live FK reference.
alter table public.face_registration_logs add column if not exists deleted_student_id uuid;
alter table public.face_registration_logs drop constraint if exists face_registration_logs_user_check;
alter table public.face_registration_logs add constraint face_registration_logs_user_check check (
    (student_id is not null and employee_id is null and deleted_student_id is null)
    or (student_id is null and employee_id is not null and deleted_student_id is null)
    or (student_id is null and employee_id is null and deleted_student_id is not null)
);

create or replace function app_private.delete_student(p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_stud_id text;
begin
    if auth.uid() is null or not coalesce(app_private.is_active_super_admin(), false) then
        raise exception 'An active, unlocked Super Admin with MFA is required.' using errcode = '42501';
    end if;
    if p_student_id is null then
        raise exception 'Student UUID is required.' using errcode = '22023';
    end if;

    -- Serialize duplicate requests and prevent new FK children during cleanup.
    select s.stud_id into v_stud_id from public.students s
      where s.student_id = p_student_id for update;
    if not found then
        return jsonb_build_object('deleted', false, 'student_id', p_student_id);
    end if;

    delete from public.sms_notifications where student_id = p_student_id;
    delete from public.gate_sms_notifications where student_id = p_student_id;
    -- The gate SMS log FK also cascades for notifications linked by log UUID.
    delete from public.entry_exit_logs where student_id = p_student_id;
    delete from public.daily_attendance where student_id = p_student_id;
    delete from public.event_attendance where student_id = p_student_id;
    delete from public.event_participants where student_id = p_student_id;
    delete from public.student_guardians where student_id = p_student_id;
    delete from public.spoof_attempts where student_id = p_student_id;
    -- Registration is an administrative audit trail, not a face dataset.
    update public.face_registration_logs set deleted_student_id = student_id, student_id = null where student_id = p_student_id;
    -- Queue rows are actionable work; rollover changes are immutable history.
    delete from public.student_id_rollover_qr_queue where student_id = p_student_id;
    -- student_face_embeddings already has ON DELETE CASCADE. Profile vectors
    -- disappear with the student. Shared guardians/events/sections are untouched.
    delete from public.students where student_id = p_student_id;
    return jsonb_build_object('deleted', true, 'student_id', p_student_id, 'stud_id', v_stud_id);
end;
$$;
alter function app_private.delete_student(uuid) owner to postgres;
revoke all on function app_private.delete_student(uuid) from public, anon, authenticated;
grant execute on function app_private.delete_student(uuid) to authenticated;

create or replace function public.delete_student(p_student_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
    select app_private.delete_student(p_student_id);
$$;
revoke all on function public.delete_student(uuid) from public, anon, authenticated;
grant execute on function public.delete_student(uuid) to authenticated;
-- Require browsers to use the atomic operation; keep privileged engine grants.
revoke delete on public.students from authenticated;
notify pgrst, 'reload schema';
commit;
