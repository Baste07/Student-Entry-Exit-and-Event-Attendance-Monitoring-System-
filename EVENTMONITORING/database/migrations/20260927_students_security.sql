-- Student write boundary. Apply after 20260926_admins_security.sql.
-- Safe either before or after 20260928_student_id_rollover.sql: the latter
-- grants its newly added current_grade_level column to authenticated users.
-- Keep service_role grants for the two local Python face services.
begin;

do $$
declare v_column record;
begin
    if to_regprocedure('app_private.is_active_super_admin()') is null then
        raise exception 'Apply the admin security migration first';
    end if;

    -- Table revocation does not remove separately granted column privileges.
    revoke all on table public.students from public, anon, authenticated;
    for v_column in
        select attname from pg_attribute
         where attrelid = 'public.students'::regclass
           and attnum > 0 and not attisdropped
    loop
        execute format('revoke all (%I) on table public.students from public, anon, authenticated',
                       v_column.attname);
    end loop;
end $$;

-- Event, gate, registration, reporting, and admin pages need student reads.
-- No browser role can modify the permanent UUID after insertion.
grant select on table public.students to authenticated;
-- The synthetic development fixture omits optional production columns.
-- Intersect the reviewed allowlists with columns actually present, so this
-- same migration is testable there without granting future unknown columns.
do $$
declare
    v_insert text;
    v_update text;
begin
    select string_agg(format('%I', attname), ', ' order by attnum) into v_insert
      from pg_attribute
     where attrelid = 'public.students'::regclass and attnum > 0 and not attisdropped
       and attname = any (array['student_id','stud_id','first_name','middle_name',
                                 'last_name','suffix','birth_date','gender','section_id',
                                 'school_year_id','address','email','status','created_at',
                                 'updated_at','current_grade_level']);
    select string_agg(format('%I', attname), ', ' order by attnum) into v_update
      from pg_attribute
     where attrelid = 'public.students'::regclass and attnum > 0 and not attisdropped
       and attname = any (array['stud_id','first_name','middle_name','last_name',
                                 'suffix','birth_date','gender','section_id',
                                 'school_year_id','address','email','status',
                                 'updated_at','current_grade_level']);
    execute format('grant insert (%s) on table public.students to authenticated', v_insert);
    execute format('grant update (%s) on table public.students to authenticated', v_update);
end $$;
grant delete on table public.students to authenticated;

alter table public.students enable row level security;
drop policy if exists "Enable read for authenticated users" on public.students;
drop policy if exists "Enable insert for authenticated users" on public.students;
drop policy if exists "Enable update for authenticated users" on public.students;
drop policy if exists "Enable delete for authenticated users" on public.students;
drop policy if exists "Students read for authenticated users" on public.students;
drop policy if exists "Super Admin student insert" on public.students;
drop policy if exists "Super Admin student update" on public.students;
drop policy if exists "Super Admin student delete" on public.students;
drop policy if exists "Student insert Super Admin boundary" on public.students;
drop policy if exists "Student update Super Admin boundary" on public.students;
drop policy if exists "Student delete Super Admin boundary" on public.students;

create policy "Students read for authenticated users"
on public.students for select to authenticated using (true);

create policy "Super Admin student insert"
on public.students for insert to authenticated
with check ((select app_private.is_active_super_admin()));
create policy "Student insert Super Admin boundary"
on public.students as restrictive for insert to authenticated
with check ((select app_private.is_active_super_admin()));

create policy "Super Admin student update"
on public.students for update to authenticated
using ((select app_private.is_active_super_admin()))
with check ((select app_private.is_active_super_admin()));
create policy "Student update Super Admin boundary"
on public.students as restrictive for update to authenticated
using ((select app_private.is_active_super_admin()))
with check ((select app_private.is_active_super_admin()));

create policy "Super Admin student delete"
on public.students for delete to authenticated
using ((select app_private.is_active_super_admin()));
create policy "Student delete Super Admin boundary"
on public.students as restrictive for delete to authenticated
using ((select app_private.is_active_super_admin()));

commit;
