-- Read-only preflight. Never apply a migration based on this query alone.
with student_years as (
    select sy.id, sy.name, sy.start_date, sy.end_date, sy.is_active,
           count(s.student_id) filter (where s.status = 'active') as active_students,
           (select following.id from public.school_years following
            where extract(year from following.start_date) = extract(year from sy.end_date)
              and following.start_date > sy.start_date
            order by following.start_date limit 1) as next_school_year_id
      from public.school_years sy left join public.students s on s.school_year_id = sy.id
     group by sy.id, sy.name, sy.start_date, sy.end_date, sy.is_active
), candidate as (
    select s.student_id, s.stud_id, s.school_year_id,
           case when split_part(s.stud_id, '-', 1) in ('K','k')
                then '1-' || split_part(s.stud_id, '-', 2)
                when split_part(s.stud_id, '-', 1) ~ '^[1-9]$'
                then (split_part(s.stud_id, '-', 1)::integer + 1)::text
                     || '-' || split_part(s.stud_id, '-', 2)
                else null end as target_id
      from public.students s
     where s.status = 'active'
       and s.stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
), occupied as (
    select c.stud_id as source_id, c.target_id, other.stud_id as occupied_id,
           other.status as occupant_status,
           other.school_year_id as occupant_school_year_id
      from candidate c join public.students other on other.stud_id = c.target_id
       and other.student_id <> c.student_id
     where c.target_id is not null
)
select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'student_count', (select count(*) from public.students),
  'null_stud_id', (select count(*) from public.students where stud_id is null),
  'malformed_stud_id', (select count(*) from public.students
     where stud_id is not null and stud_id !~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'),
  'duplicate_stud_id', (select count(*) from
      (select stud_id from public.students group by stud_id having count(*) > 1) d),
  'student_columns', (select jsonb_agg(jsonb_build_object(
      'name',column_name,'type',data_type,'nullable',is_nullable) order by ordinal_position)
      from information_schema.columns where table_schema='public' and table_name='students'),
  'school_years', (select jsonb_agg(to_jsonb(student_years) order by start_date)
      from student_years),
  'target_occupants', (select coalesce(jsonb_agg(to_jsonb(occupied)), '[]'::jsonb)
      from occupied),
  'rollover_column_exists', exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='students'
        and column_name='current_grade_level'),
  'rollover_table_exists', to_regclass('public.student_id_rollovers') is not null,
  'student_security_helper_exists', to_regprocedure('app_private.is_active_super_admin()') is not null,
  'cron_extension_installed', exists(select 1 from pg_extension where extname='pg_cron'),
  'cron_extension_available', exists(select 1 from pg_available_extensions where name='pg_cron'),
  'cron_relation_exists', to_regclass('cron.job') is not null,
  'settings', (select coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      from public.system_settings where key in
        ('sms_enabled','anti_spoof_enabled','school_year_end_month_day'))
) as preflight;
