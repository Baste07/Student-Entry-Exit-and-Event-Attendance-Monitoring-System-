-- DEVELOPMENT PROJECT ONLY. Recreate the state before the rollover migration.
-- Run only with an independently verified development-project CLI link.
begin;
do $$ begin
  if (select count(*) from public.students) <> 0
     or (select count(*) from public.student_id_rollovers) <> 0
     or (select count(*) from public.student_id_rollover_changes) <> 0
     or (select count(*) from public.student_id_rollover_qr_queue) <> 0
     or (select count(*) from cron.job where jobname='student-id-rollover-daily') <> 1
     or (select count(*) from pg_proc where pronamespace='student_rollover_private'::regnamespace) <> 5
  then raise exception 'Development rollover reset preflight failed'; end if;
end $$;

select cron.unschedule('student-id-rollover-daily');
drop function public.mark_student_rollover_qr_reissued(uuid, uuid);
drop function public.student_qr_uuid_required();
drop function public.run_student_id_rollover(uuid);
drop function public.preview_student_id_rollover(uuid);
drop trigger students_initialize_current_grade on public.students;
drop schema student_rollover_private cascade;
drop table public.student_id_rollover_qr_queue;
drop table public.student_id_rollover_changes;
drop table public.student_id_rollovers;
drop index if exists public.students_current_grade_level_idx;
alter table public.students drop constraint students_current_grade_matches_id;
alter table public.students drop constraint students_current_grade_level_valid;
alter table public.students drop column current_grade_level;
alter table public.system_settings drop constraint school_year_end_month_day_valid;
delete from public.system_settings where key='school_year_end_month_day' and value='03-25';

drop policy "Read system capabilities" on public.system_settings;
drop policy "Super admins insert system capabilities" on public.system_settings;
drop policy "Super admins update system capabilities" on public.system_settings;
drop policy "System capability insert boundary" on public.system_settings;
drop policy "System capability update boundary" on public.system_settings;
create policy "Read system capabilities" on public.system_settings for select
  to anon, authenticated using (key in ('sms_enabled','anti_spoof_enabled'));
create policy "Super admins insert system capabilities" on public.system_settings for insert
  to authenticated with check (key in ('sms_enabled','anti_spoof_enabled')
    and exists (select 1 from public.admins where admin_id=(select auth.uid())
      and admin_level='super_admin' and status='active'));
create policy "Super admins update system capabilities" on public.system_settings for update
  to authenticated using (key in ('sms_enabled','anti_spoof_enabled')
    and exists (select 1 from public.admins where admin_id=(select auth.uid())
      and admin_level='super_admin' and status='active'))
  with check (key in ('sms_enabled','anti_spoof_enabled')
    and exists (select 1 from public.admins where admin_id=(select auth.uid())
      and admin_level='super_admin' and status='active'));
create policy "System capability insert boundary" on public.system_settings as restrictive
  for insert to authenticated with check (key in ('sms_enabled','anti_spoof_enabled')
    and exists (select 1 from public.admins where admin_id=(select auth.uid())
      and admin_level='super_admin' and status='active'));
create policy "System capability update boundary" on public.system_settings as restrictive
  for update to authenticated using (key in ('sms_enabled','anti_spoof_enabled')
    and exists (select 1 from public.admins where admin_id=(select auth.uid())
      and admin_level='super_admin' and status='active'))
  with check (key in ('sms_enabled','anti_spoof_enabled')
    and exists (select 1 from public.admins where admin_id=(select auth.uid())
      and admin_level='super_admin' and status='active'));
commit;
