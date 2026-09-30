-- DEVELOPMENT ONLY. Every fixture and edit is rolled back.
begin;
do $$
declare v_normal uuid; v_super uuid; v_year uuid := gen_random_uuid();
        v_section uuid := gen_random_uuid(); v_student uuid := gen_random_uuid();
        v_stud_id text;
begin
    select admin_id into v_normal from public.admins
     where admin_level='admin' and status='active' limit 1;
    select admin_id into v_super from public.admins
     where admin_level='super_admin' and status='active' limit 1;
    if v_normal is null or v_super is null then raise exception 'Both active identities required'; end if;
    if has_table_privilege('authenticated','public.students','TRUNCATE')
       or has_table_privilege('anon','public.students','TRUNCATE')
       or has_table_privilege('anon','public.students','INSERT')
       or has_table_privilege('anon','public.students','UPDATE')
       or has_table_privilege('anon','public.students','DELETE')
       or has_column_privilege('authenticated','public.students','student_id','UPDATE')
       or has_column_privilege('authenticated','public.students','facial_dataset_path','UPDATE')
       or not has_column_privilege('authenticated','public.students','current_grade_level','UPDATE')
       or not has_table_privilege('service_role','public.students','UPDATE') then
        raise exception 'Student grants differ from planned boundary';
    end if;
    insert into public.school_years(id,name,start_date,end_date)
      values(v_year,'2018-2019 Student Security Fixture','2018-06-01','2019-03-31');
    insert into public.sections(section_id,grade_level,section_name,school_year_id)
      values(v_section,'Grade 1','Security Fixture',v_year);
    loop
        v_stud_id := '1-' || lpad((5000+floor(random()*4000))::int::text,4,'0');
        exit when not exists(select 1 from public.students where stud_id=v_stud_id);
    end loop;
    insert into public.students(student_id,stud_id,first_name,last_name,section_id,
                                school_year_id,status)
      values(v_student,v_stud_id,'Security','Fixture',v_section,v_year,'active');
    perform set_config('security.normal',v_normal::text,true);
    perform set_config('security.super',v_super::text,true);
    perform set_config('security.student',v_student::text,true);
    perform set_config('security.stud_id',v_stud_id,true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('security.normal'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
do $$
declare n int;
begin
    if not exists (select 1 from public.students
      where student_id=current_setting('security.student')::uuid
        and current_grade_level='Grade 1') then
        raise exception 'Authenticated normal Admin cannot resolve UUID student grade for QR lookup';
    end if;
    update public.students set current_grade_level='Grade 2',stud_id='2-9999',
       school_year_id=gen_random_uuid(),section_id=gen_random_uuid(),
       status='inactive' where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>0 then raise exception 'Normal Admin changed protected student fields'; end if;
    update public.students set first_name='Unauthorized'
      where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>0 then raise exception 'Normal Admin changed student details'; end if;
    delete from public.students where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>0 then raise exception 'Normal Admin deleted student'; end if;
    begin
        insert into public.students(stud_id,first_name,last_name,status)
        values('1-9999','Unauthorized','Student','active');
        raise exception 'Normal Admin inserted student';
    exception when insufficient_privilege then null;
    end;
    begin
        update public.students set student_id=gen_random_uuid()
          where student_id=current_setting('security.student')::uuid;
        raise exception 'Browser UPDATE of permanent UUID was granted';
    exception when insufficient_privilege then null;
    end;
    begin
        update public.students set facial_dataset_path='unauthorized'
          where student_id=current_setting('security.student')::uuid;
        raise exception 'Browser UPDATE of face metadata was granted';
    exception when insufficient_privilege then null;
    end;
end $$;
reset role;

update public.admins set status='suspended'
 where admin_id=current_setting('security.normal')::uuid;
set local role authenticated;
do $$
declare n int;
begin
    update public.students set email='suspended@example.invalid'
     where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>0 then raise exception 'Suspended Admin changed student'; end if;
    delete from public.students where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>0 then raise exception 'Suspended Admin deleted student'; end if;
    begin
        insert into public.students(stud_id,first_name,last_name,status)
        values('1-9998','Suspended','Student','active');
        raise exception 'Suspended Admin inserted student';
    exception when insufficient_privilege then null;
    end;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('security.super'),true);
set local role authenticated;
do $$
declare n int; v_id uuid := gen_random_uuid();
begin
    update public.students set first_name='Managed',status='inactive',
        current_grade_level='Grade 1'
     where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>1 then raise exception 'Super Admin edit/status failed'; end if;
    insert into public.students(student_id,stud_id,current_grade_level,
                                first_name,last_name,status)
    values(v_id,'1-9876','Grade 1','New','Student','active');
    if not exists(select 1 from public.students where student_id=v_id) then
        raise exception 'Super Admin registration failed'; end if;
    delete from public.students where student_id=v_id;
    get diagnostics n=row_count;
    if n<>1 then raise exception 'Super Admin delete failed'; end if;
    begin
        update public.students set student_id=gen_random_uuid()
         where student_id=current_setting('security.student')::uuid;
        raise exception 'Super Admin browser changed permanent UUID';
    exception when insufficient_privilege then null;
    end;
end $$;
reset role;

set local role service_role;
do $$
declare n int;
begin
    update public.students set facial_dataset_path='students/test-only'
      where student_id=current_setting('security.student')::uuid;
    get diagnostics n=row_count;
    if n<>1 then raise exception 'Face service-role update failed'; end if;
end $$;
reset role;
rollback;
