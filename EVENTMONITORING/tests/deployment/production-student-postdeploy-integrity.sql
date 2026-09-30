-- Read-only post-deployment integrity snapshot. Compare student identity fields
-- against the locally saved pre-deployment snapshot; do not print face data.
select jsonb_build_object(
  'students', (select jsonb_agg(jsonb_build_object(
      'student_id',student_id,'stud_id',stud_id,'school_year_id',school_year_id,
      'section_id',section_id,'status',status,'current_grade_level',current_grade_level)
      order by student_id) from public.students),
  'student_count', (select count(*) from public.students),
  'null_grade', (select count(*) from public.students
      where stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
        and current_grade_level is null),
  'grade_mismatch', (select count(*) from public.students
      where stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'
        and current_grade_level is distinct from case
          when upper(split_part(stud_id,'-',1))='K' then 'Kinder'
          else 'Grade ' || split_part(stud_id,'-',1) end),
  'duplicate_stud_id', (select count(*) from
      (select stud_id from public.students group by stud_id having count(*)>1) d),
  'dummy_grades', (select jsonb_agg(jsonb_build_object(
      'stud_id',stud_id,'grade',current_grade_level,'section_id',section_id)
      order by stud_id) from public.students
      where stud_id in ('1-0016','1-0018','1-0034')),
  'orphan_student_guardians', (select count(*) from public.student_guardians x
      left join public.students s using(student_id) where s.student_id is null),
  'orphan_event_participants', (select count(*) from public.event_participants x
      left join public.students s using(student_id)
      where x.student_id is not null and s.student_id is null),
  'orphan_event_attendance', (select count(*) from public.event_attendance x
      left join public.students s using(student_id)
      where x.student_id is not null and s.student_id is null),
  'orphan_entry_exit_logs', (select count(*) from public.entry_exit_logs x
      left join public.students s using(student_id)
      where x.student_id is not null and s.student_id is null),
  'link_counts', jsonb_build_object(
      'student_guardians',(select count(*) from public.student_guardians),
      'event_participants',(select count(*) from public.event_participants),
      'event_attendance',(select count(*) from public.event_attendance),
      'entry_exit_logs',(select count(*) from public.entry_exit_logs)),
  'rollover_history', (select count(*) from public.student_id_rollovers),
  'qr_queue', (select count(*) from public.student_id_rollover_qr_queue),
  'school_year_end_setting', (select value from public.system_settings
      where key='school_year_end_month_day'),
  'cron_jobs', (select jsonb_agg(jsonb_build_object(
      'jobid',jobid,'jobname',jobname,'schedule',schedule,'command',command,
      'active',active) order by jobid)
      from cron.job where jobname='student-id-rollover-daily')
) as integrity;
