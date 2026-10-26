-- DEVELOPMENT ONLY. Run after the migration in the SAME rollback transaction.
-- Supplemental tables cover production relationships absent in the dev fixture.
create table if not exists public.daily_attendance (attendance_id uuid primary key default gen_random_uuid(), student_id uuid references public.students(student_id));
create table if not exists public.spoof_attempts (spoof_log_id uuid primary key default gen_random_uuid(), student_id uuid references public.students(student_id));
create table if not exists public.sms_notifications (sms_id uuid primary key default gen_random_uuid(), student_id uuid references public.students(student_id));
create table if not exists public.face_registration_logs (
    registration_log_id uuid primary key default gen_random_uuid(),
    student_id uuid references public.students(student_id), employee_id uuid,
    constraint face_registration_logs_user_check check (
      (student_id is not null and employee_id is null) or (student_id is null and employee_id is not null))
);

-- Tests start here (the runner installs the migration after the fixture schema).

create function pg_temp.fail_student_delete() returns trigger language plpgsql as $$
begin raise exception 'controlled deletion failure'; end $$;

do $$
declare
    a uuid := gen_random_uuid(); s uuid := gen_random_uuid(); other uuid := gen_random_uuid();
    g uuid; e uuid; gate uuid; result jsonb; audit_id uuid; y uuid; ny uuid;
begin
    insert into auth.users(id,email) values(a, a::text || '@student-delete.invalid');
    insert into public.admins(admin_id,email,password,admin_level,status)
      values(a,a::text || '@student-delete.invalid','unused-test-only','super_admin','active');
    perform set_config('request.jwt.claims', jsonb_build_object('sub',a,'role','authenticated','aal','aal2')::text,true);

    insert into public.students(student_id,stud_id,first_name,last_name) values(s,'1-9871','Deletion','Fixture');
    result := public.delete_student(s);
    if result->>'deleted' <> 'true' or exists(select 1 from public.students where student_id=s) then raise exception 'empty student deletion failed'; end if;
    if public.delete_student(s)->>'deleted' <> 'false' then raise exception 'repeat deletion failed'; end if;

    insert into public.students(student_id,stud_id,first_name,last_name) values(s,'1-9871','Deletion','Fixture'),(other,'1-9872','Surviving','Fixture');
    insert into public.spoof_attempts(student_id) values(s),(other);
    perform public.delete_student(s);
    if exists(select 1 from public.spoof_attempts where student_id=s) or not exists(select 1 from public.spoof_attempts where student_id=other) then raise exception 'spoof isolation failed'; end if;

    insert into public.students(student_id,stud_id,first_name,last_name) values(s,'1-9871','Deletion','Fixture');
    insert into public.guardians(first_name,last_name,relationship,phone_number) values('Shared','Fixture','parent','00000000000') returning guardian_id into g;
    insert into public.student_guardians(student_id,guardian_id) values(s,g),(other,g);
    insert into public.events(event_name,event_date) values('Student deletion isolated fixture',current_date) returning event_id into e;
    insert into public.event_participants(event_id,student_id) values(e,s),(e,other);
    insert into public.event_attendance(event_id,student_id) values(e,s);
    insert into public.daily_attendance(student_id) values(s);
    insert into public.sms_notifications(student_id) values(s);
    insert into public.spoof_attempts(student_id) values(s);
    insert into public.face_registration_logs(student_id) values(s) returning registration_log_id into audit_id;
    insert into public.entry_exit_logs(student_id,log_type,scan_method,log_date) values(s,'entry','qr',current_date) returning id into gate;
    insert into public.gate_sms_notifications(entry_exit_log_id,student_id) values(gate,s);
    insert into public.student_face_embeddings(student_id,image_slot,embedding,source_image_name,source_image_path,dataset_fingerprint)
      values(s,1,array_fill(0.01::real,array[128])::public.vector,'fixture.jpg','fixture/fixture.jpg',repeat('a',64));
    insert into public.school_years(name,start_date,end_date) values('Deletion fixture year',date '2090-01-01',date '2090-12-31') returning id into y;
    insert into public.school_years(name,start_date,end_date) values('Deletion fixture next',date '2091-01-01',date '2091-12-31') returning id into ny;
    insert into public.student_id_rollovers(school_year_id,next_school_year_id,school_year_end_month_day,execution_mode,processed_count,inactive_count,highest_grade_count)
      values(y,ny,'03-25','manual',1,0,0);
    insert into public.student_id_rollover_changes(school_year_id,student_id,old_stud_id,new_stud_id) values(y,s,'K-9871','1-9871');
    insert into public.student_id_rollover_qr_queue(school_year_id,student_id) values(y,s);

    -- Failure after child cleanup MUST restore every preceding write.
    execute 'create trigger student_delete_fixture_failure before delete on public.students for each row execute function pg_temp.fail_student_delete()';
    begin
        perform public.delete_student(s);
        raise exception 'failure trigger did not fire';
    exception when raise_exception then
        if sqlerrm <> 'controlled deletion failure' then raise; end if;
    end;
    if not exists(select 1 from public.spoof_attempts where student_id=s)
       or not exists(select 1 from public.sms_notifications where student_id=s)
       or not exists(select 1 from public.entry_exit_logs where id=gate)
       or not exists(select 1 from public.face_registration_logs where registration_log_id=audit_id and student_id=s)
       then raise exception 'transaction rollback failed'; end if;
    execute 'drop trigger student_delete_fixture_failure on public.students';

    perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','aal','aal1')::text,true);
    begin perform public.delete_student(s); raise exception 'unauthorized deletion accepted';
    exception when insufficient_privilege then null; end;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','aal','aal2')::text,true);
    update public.admins set admin_level='admin' where admin_id=a;
    begin perform public.delete_student(s); raise exception 'regular admin deletion accepted';
    exception when insufficient_privilege then null; end;
    update public.admins set admin_level='super_admin',login_locked=true,login_locked_at=now() where admin_id=a;
    begin perform public.delete_student(s); raise exception 'locked admin deletion accepted';
    exception when insufficient_privilege then null; end;
    update public.admins set login_locked=false,login_locked_at=null where admin_id=a;
    execute 'set local role authenticated';
    result := public.delete_student(s);
    execute 'reset role';
    if result->>'deleted' <> 'true' then raise exception 'authenticated RPC failed'; end if;
    if exists(select 1 from public.students where student_id=s)
       or exists(select 1 from public.student_guardians where student_id=s)
       or exists(select 1 from public.event_participants where student_id=s)
       or exists(select 1 from public.event_attendance where student_id=s)
       or exists(select 1 from public.daily_attendance where student_id=s)
       or exists(select 1 from public.sms_notifications where student_id=s)
       or exists(select 1 from public.spoof_attempts where student_id=s)
       or exists(select 1 from public.entry_exit_logs where id=gate)
       or exists(select 1 from public.gate_sms_notifications where entry_exit_log_id=gate)
       or exists(select 1 from public.student_face_embeddings where student_id=s)
       or exists(select 1 from public.student_id_rollover_qr_queue where student_id=s)
       then raise exception 'dependent cleanup failed'; end if;
    if not exists(select 1 from public.guardians where guardian_id=g)
       or not exists(select 1 from public.events where event_id=e)
       or not exists(select 1 from public.student_guardians where student_id=other and guardian_id=g)
       or not exists(select 1 from public.event_participants where student_id=other and event_id=e)
       or not exists(select 1 from public.face_registration_logs where registration_log_id=audit_id and student_id is null and deleted_student_id=s)
       or not exists(select 1 from public.student_id_rollover_changes where school_year_id=y and student_id=s)
       then raise exception 'shared record or audit retention failed'; end if;
    if has_function_privilege('anon','public.delete_student(uuid)','execute')
       or has_table_privilege('authenticated','public.students','delete')
       or not has_function_privilege('authenticated','public.delete_student(uuid)','execute')
       then raise exception 'privilege boundary failed'; end if;
end $$;
select 'PASS: empty, spoof, multiple dependents, shared masters, integrity, rollback, MFA denial, repeated request, privileges' as student_deletion_tests;
