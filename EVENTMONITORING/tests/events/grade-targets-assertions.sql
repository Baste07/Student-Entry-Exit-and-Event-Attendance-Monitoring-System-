create function codex_event_target_private.fail_target_insert_for_test()
returns trigger language plpgsql as $$
begin
  if current_setting('codex.fail_target_insert', true) = 'on'
     and new.grade_level = 'Grade 3' then
    raise exception 'Injected target write failure';
  end if;
  return new;
end;
$$;
create trigger fail_target_insert_for_test before insert
  on codex_event_target_test.event_grade_targets for each row
  execute function codex_event_target_private.fail_target_insert_for_test();

do $$
declare
  y uuid := gen_random_uuid();
  sec_a uuid := gen_random_uuid();
  sec_b uuid := gen_random_uuid();
  sec_g2 uuid := gen_random_uuid();
  sec_future uuid := gen_random_uuid();
  stu_a uuid := gen_random_uuid();
  stu_b uuid := gen_random_uuid();
  stu_c uuid := gen_random_uuid();
  event_specific uuid;
  event_all uuid;
  event_legacy uuid;
  event_completed uuid;
  event_multi uuid;
  event_mixed uuid;
  event_every uuid;
  event_override uuid;
  y_other uuid := gen_random_uuid();
  sec_other uuid := gen_random_uuid();
  all_rules jsonb;
  target_before uuid;
  roster_before integer;
  stu_attended uuid := gen_random_uuid();
  before_events integer;
  saw_error boolean;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform pg_catalog.set_config('codex.event_target_state', 'super-aal2', true);
  perform pg_catalog.set_config('codex.event_target_year', y::text, true);
  insert into codex_event_target_test.school_years(id) values (y);
  insert into codex_event_target_test.sections(section_id,grade_level,section_name,school_year_id)
    values (sec_a,'Grade 1','A',y),(sec_b,'Grade 1','B',y),(sec_g2,'Grade 2','A',y);
  insert into codex_event_target_test.students(student_id,section_id,school_year_id,current_grade_level,status)
    values (stu_a,sec_a,y,'Grade 1','active'),(stu_b,sec_b,y,'Grade 1','active'),
           (stu_c,sec_g2,y,'Grade 2','active');
  -- C: multiple specific sections in one grade.
  event_multi := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Multi-section test","event_date":"2099-01-01"}'::jsonb,
    y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
      'all_sections',false,'section_ids',jsonb_build_array(sec_a::text,sec_b::text))));
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_multi) <> 2 then
    raise exception 'C: multiple sections failed';
  end if;
  -- D/E: multiple grades, including a specific section in only one grade.
  event_mixed := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Mixed-grade test","event_date":"2099-01-01"}'::jsonb,
    y,jsonb_build_array(
      jsonb_build_object('grade_level','Grade 1','all_sections',false,
        'section_ids',jsonb_build_array(sec_a::text)),
      jsonb_build_object('grade_level','Grade 2','all_sections',true,'section_ids','[]'::jsonb)));
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_mixed) <> 2 then
    raise exception 'E: mixed grade targeting failed';
  end if;
  event_mixed := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Mixed-grade test","event_date":"2099-01-01"}'::jsonb,
    y,jsonb_build_array(
      jsonb_build_object('grade_level','Grade 1','all_sections',true,'section_ids','[]'::jsonb),
      jsonb_build_object('grade_level','Grade 2','all_sections',true,'section_ids','[]'::jsonb)), event_mixed);
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_mixed) <> 3 then
    raise exception 'D: multiple all-section grades failed';
  end if;
  -- H/K: removing one grade is transactional; unchanged save creates no duplicate.
  event_mixed := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Mixed-grade test","event_date":"2099-01-01"}'::jsonb,
    y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
      'all_sections',true,'section_ids','[]'::jsonb)), event_mixed);
  if (select count(*) from codex_event_target_test.event_grade_targets where event_id=event_mixed) <> 1
     or (select count(*) from codex_event_target_test.event_participants where event_id=event_mixed) <> 2 then
    raise exception 'H: removed grade remained in targets or roster';
  end if;
  select target_id into target_before from codex_event_target_test.event_grade_targets where event_id=event_mixed;
  perform codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Mixed-grade test","event_date":"2099-01-01"}'::jsonb,
    y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
      'all_sections',true,'section_ids','[]'::jsonb)),event_mixed);
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_mixed) <> 2
     or (select target_id from codex_event_target_test.event_grade_targets where event_id=event_mixed) <> target_before then
    raise exception 'K: unchanged save rebuilt targets or roster';
  end if;
  -- F/G: all grades may coexist with a specific Grade 1 override.
  select jsonb_agg(jsonb_build_object('grade_level',grade,'all_sections',true,
    'section_ids','[]'::jsonb)) into all_rules
    from unnest(array['Kinder','Grade 1','Grade 2','Grade 3','Grade 4',
      'Grade 5','Grade 6','Grade 7','Grade 8','Grade 9','Grade 10']) as g(grade);
  event_every := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Every grade test","event_date":"2099-01-01"}'::jsonb,y,all_rules);
  if (select count(*) from codex_event_target_test.event_grade_targets where event_id=event_every) <> 11
     or (select count(*) from codex_event_target_test.event_participants where event_id=event_every) <> 3 then
    raise exception 'F: all grades/all sections failed';
  end if;
  select jsonb_agg(case when rule->>'grade_level'='Grade 1'
    then jsonb_build_object('grade_level','Grade 1','all_sections',false,
      'section_ids',jsonb_build_array(sec_a::text)) else rule end) into all_rules
    from jsonb_array_elements(all_rules) as r(rule);
  event_override := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Every grade override test","event_date":"2099-01-01"}'::jsonb,y,all_rules);
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_override) <> 2 then
    raise exception 'G: all grades with override failed';
  end if;
  -- J: a section from another school year is rejected before any Event is saved.
  insert into codex_event_target_test.school_years(id) values(y_other);
  insert into codex_event_target_test.sections(section_id,grade_level,section_name,school_year_id)
    values(sec_other,'Grade 1','Other year',y_other);
  saw_error := false;
  begin
    perform codex_event_target_test.save_grade_targeted_event(
      '{"event_name":"Wrong year","event_date":"2099-01-01"}'::jsonb,
      y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
        'all_sections',false,'section_ids',jsonb_build_array(sec_other::text))));
  exception when check_violation then saw_error := true;
  end;
  if not saw_error then raise exception 'J: wrong-school-year section accepted'; end if;
  event_specific := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Specific test","event_date":"2099-01-01","status":"upcoming"}'::jsonb,
    y, jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
      'all_sections',false,'section_ids',jsonb_build_array(sec_a::text))));
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_specific) <> 1
     or not exists (select 1 from codex_event_target_test.event_participants
                    where event_id=event_specific and student_id=stu_a) then
    raise exception 'specific-section roster failed';
  end if;
  event_all := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"All test","event_date":"2099-01-01","status":"upcoming"}'::jsonb,
    y, jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
      'all_sections',true,'section_ids','[]'::jsonb)));
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_all) <> 2 then
    raise exception 'all-sections roster failed';
  end if;
  if (select count(*) from codex_event_target_test.preview_event_grade_participants(
      y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
      'all_sections',true,'section_ids','[]'::jsonb)))) <> 2 then
    raise exception 'preview and roster disagree';
  end if;
  insert into codex_event_target_test.students(student_id,section_id,school_year_id,current_grade_level,status)
    values (gen_random_uuid(),sec_b,y,'Grade 1','active');
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_all) <> 3
     or (select count(*) from codex_event_target_test.event_participants where event_id=event_specific) <> 1 then
    raise exception 'new student sync failed';
  end if;
  insert into codex_event_target_test.sections(section_id,grade_level,section_name,school_year_id)
    values (sec_future,'Grade 1','Future',y);
  insert into codex_event_target_test.students(student_id,section_id,school_year_id,current_grade_level,status)
    values (gen_random_uuid(),sec_future,y,'Grade 1','active');
  if (select count(*) from codex_event_target_test.event_participants where event_id=event_all) <> 4 then
    raise exception 'future section/student did not join All Sections';
  end if;
  update codex_event_target_test.students set section_id=sec_a where student_id=stu_b;
  if not exists (select 1 from codex_event_target_test.event_participants
                 where event_id=event_specific and student_id=stu_b) then
    raise exception 'reassigned student did not join specific section';
  end if;
  update codex_event_target_test.students set section_id=sec_b where student_id=stu_b;
  if exists (select 1 from codex_event_target_test.event_participants
             where event_id=event_specific and student_id=stu_b) then
    raise exception 'reassigned student did not leave specific section';
  end if;  update codex_event_target_test.students set status='inactive' where student_id=stu_a;
  if exists (select 1 from codex_event_target_test.event_participants
             where event_id in (event_specific,event_all) and student_id=stu_a) then
    raise exception 'inactive student removal failed';
  end if;
  -- S/T: an attended student leaving a targeted section retains the roster
  -- link and can complete Time Out. Preview agrees with that retained roster.
  insert into codex_event_target_test.students(student_id,section_id,school_year_id,current_grade_level,status)
    values (stu_attended,sec_a,y,'Grade 1','active');
  insert into codex_event_target_test.event_attendance(event_id,student_id,time_in)
    values (event_specific,stu_attended,now());
  update codex_event_target_test.students set section_id=sec_b where student_id=stu_attended;
  if not exists (select 1 from codex_event_target_test.event_participants
                 where event_id=event_specific and student_id=stu_attended)
     or not exists (select 1 from codex_event_target_test.event_attendance
                    where event_id=event_specific and student_id=stu_attended)
     or not exists (select 1 from codex_event_target_test.preview_event_grade_participants(
         y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
         'all_sections',false,'section_ids',jsonb_build_array(sec_a::text))),event_specific)
         where student_id=stu_attended) then
    raise exception 'S: attended participant removed or preview disagrees';
  end if;
  -- R: a failure after metadata and target DELETE must roll back the entire edit.
  select target_id into target_before from codex_event_target_test.event_grade_targets
    where event_id=event_mixed;
  select count(*) into roster_before from codex_event_target_test.event_participants
    where event_id=event_mixed;
  perform pg_catalog.set_config('codex.fail_target_insert', 'on', true);
  saw_error := false;
  begin
    perform codex_event_target_test.save_grade_targeted_event(
      '{"event_name":"Should roll back","event_date":"2099-01-01"}'::jsonb,
      y,jsonb_build_array(jsonb_build_object('grade_level','Grade 3',
        'all_sections',true,'section_ids','[]'::jsonb)),event_mixed);
  exception when others then saw_error := true;
  end;
  perform pg_catalog.set_config('codex.fail_target_insert', 'off', true);
  if not saw_error
     or (select event_name from codex_event_target_test.events where event_id=event_mixed) <> 'Mixed-grade test'
     or (select target_id from codex_event_target_test.event_grade_targets where event_id=event_mixed) <> target_before
     or (select count(*) from codex_event_target_test.event_participants where event_id=event_mixed) <> roster_before then
    raise exception 'R: failed edit left partial Event, target, or roster changes';
  end if;
  update codex_event_target_test.event_attendance set time_out=now()
    where event_id=event_specific and student_id=stu_attended;
  if (select count(*) from codex_event_target_test.event_attendance
      where event_id=event_specific and student_id=stu_attended and time_out is not null) <> 1 then
    raise exception 'T: attended student could not complete Time Out';
  end if;
  -- U: the existing stu_b reassignment check above proves removal without attendance.
  -- V: a completed Event is frozen even when a previously eligible student changes.
  event_completed := codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Completed test","event_date":"2099-01-01","status":"upcoming"}'::jsonb,
    y,jsonb_build_array(jsonb_build_object('grade_level','Grade 2',
      'all_sections',true,'section_ids','[]'::jsonb)));
  update codex_event_target_test.events set status='completed' where event_id=event_completed;
  update codex_event_target_test.students set status='inactive' where student_id=stu_c;
  if not exists (select 1 from codex_event_target_test.event_participants
                 where event_id=event_completed and student_id=stu_c) then
    raise exception 'V: completed Event roster changed automatically';
  end if;
  select target_id into target_before from codex_event_target_test.event_grade_targets where event_id=event_completed;
  perform codex_event_target_test.save_grade_targeted_event(
    '{"event_name":"Completed metadata edit","event_date":"2099-01-01","status":"completed"}'::jsonb,
    y,jsonb_build_array(jsonb_build_object('grade_level','Grade 2',
      'all_sections',true,'section_ids','[]'::jsonb)),event_completed);
  if (select target_id from codex_event_target_test.event_grade_targets where event_id=event_completed) <> target_before
     or not exists (select 1 from codex_event_target_test.event_participants
                    where event_id=event_completed and student_id=stu_c)
     or not exists (select 1 from codex_event_target_test.preview_event_grade_participants(
         y,jsonb_build_array(jsonb_build_object('grade_level','Grade 2',
         'all_sections',true,'section_ids','[]'::jsonb)),event_completed)
         where student_id=stu_c) then
    raise exception 'V: unchanged completed edit or preview lost frozen roster';
  end if;
  select count(*) into before_events from codex_event_target_test.events;
  saw_error := false;
  begin
    perform codex_event_target_test.save_grade_targeted_event(
      '{"event_name":"Wrong grade","event_date":"2099-01-01"}'::jsonb,
      y,jsonb_build_array(jsonb_build_object('grade_level','Grade 1',
        'all_sections',false,'section_ids',jsonb_build_array(sec_g2::text))));
  exception when check_violation then saw_error := true;
  end;
  if not saw_error or (select count(*) from codex_event_target_test.events) <> before_events then
    raise exception 'wrong-grade or atomic rollback failed';
  end if;
  saw_error := false;
  begin
    update codex_event_target_test.sections set grade_level='Grade 2' where section_id=sec_a;
  exception when check_violation then saw_error := true;
  end;
  if not saw_error then raise exception 'targeted-section metadata guard failed'; end if;
  saw_error := false;
  begin
    insert into codex_event_target_test.event_grade_targets(
      event_id,school_year_id,grade_level,all_sections)
      values (event_all,y,'Grade 2',false);
    set constraints codex_event_target_test.event_grade_target_complete immediate;
  exception when check_violation then saw_error := true;
  end;
  if not saw_error then raise exception 'empty specific-section target was accepted'; end if;
  saw_error := false;
  begin
    insert into codex_event_target_test.event_grade_target_sections(target_id,section_id)
      select target_id, sec_b from codex_event_target_test.event_grade_targets
      where event_id=event_all and grade_level='Grade 1';
  exception when check_violation then saw_error := true;
  end;
  if not saw_error then raise exception 'All Sections target accepted a specific section'; end if;  insert into codex_event_target_test.events(event_name,event_date,status,target_grade_level)
    values ('Legacy test','2099-01-01','upcoming','Grade 1') returning event_id into event_legacy;
  insert into codex_event_target_test.event_participants(event_id,student_id)
    values (event_legacy,stu_b);
  update codex_event_target_test.students set status='inactive' where student_id=stu_b;
  if not exists (select 1 from codex_event_target_test.event_participants
                 where event_id=event_legacy and student_id=stu_b) then
    raise exception 'legacy roster was touched';
  end if;
end;
$$;
-- Exercise the actual Postgres authenticated/anon roles and new table policies.
-- Identity states here are simulated by the isolated helper above, so this is
-- not a substitute for real application-account acceptance testing.
set local role authenticated;
set local codex.event_target_state = 'super-aal2';
do $$ begin
  if (select count(*) from codex_event_target_test.event_grade_targets) = 0 then
    raise exception 'RLS: AAL2 Super Admin cannot read targets';
  end if;
  if (select count(*) from codex_event_target_test.preview_event_grade_participants(
      current_setting('codex.event_target_year', true)::uuid,
      '[{"grade_level":"Grade 1","all_sections":true,"section_ids":[]}]'::jsonb)) = 0 then
    raise exception 'RLS: AAL2 Super Admin cannot preview';
  end if;
end $$;
set local codex.event_target_state = 'admin-aal2';
do $$ begin
  if (select count(*) from codex_event_target_test.event_grade_target_sections) = 0 then
    raise exception 'RLS: AAL2 Admin cannot read target sections';
  end if;
end $$;
set local codex.event_target_state = 'aal1';
do $$ begin
  if (select count(*) from codex_event_target_test.event_grade_targets) <> 0 then
    raise exception 'RLS: AAL1 saw targets';
  end if;
  begin
    perform codex_event_target_test.preview_event_grade_participants(
      current_setting('codex.event_target_year', true)::uuid,
      '[{"grade_level":"Grade 1","all_sections":true,"section_ids":[]}]'::jsonb);
    raise exception 'RLS: AAL1 preview RPC was allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
set local codex.event_target_state = 'inactive';
do $$ begin
  if (select count(*) from codex_event_target_test.event_grade_targets) <> 0 then
    raise exception 'RLS: inactive Admin saw targets';
  end if;
  begin
    perform codex_event_target_test.save_grade_targeted_event(
      '{"event_name":"Should fail","event_date":"2099-01-01"}'::jsonb,
      current_setting('codex.event_target_year', true)::uuid,
      '[{"grade_level":"Grade 1","all_sections":true,"section_ids":[]}]'::jsonb);
    raise exception 'RLS: inactive Admin save RPC was allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
set local codex.event_target_state = 'locked';
do $$ begin
  if (select count(*) from codex_event_target_test.event_grade_targets) <> 0 then
    raise exception 'RLS: locked Admin saw targets';
  end if;
  begin
    perform codex_event_target_test.preview_event_grade_participants(
      current_setting('codex.event_target_year', true)::uuid,
      '[{"grade_level":"Grade 1","all_sections":true,"section_ids":[]}]'::jsonb);
    raise exception 'RLS: locked Admin preview RPC was allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  if has_table_privilege('authenticated','codex_event_target_test.event_grade_targets','INSERT')
     or has_table_privilege('authenticated','codex_event_target_test.event_grade_targets','UPDATE')
     or has_table_privilege('authenticated','codex_event_target_test.event_grade_targets','DELETE') then
    raise exception 'RLS: browser DML grant appeared on target table';
  end if;
end $$;
set local role anon;
do $$ begin
  begin
    perform count(*) from codex_event_target_test.event_grade_targets;
    raise exception 'RLS: anon unexpectedly read targets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform codex_event_target_test.preview_event_grade_participants(
      current_setting('codex.event_target_year', true)::uuid,
      '[{"grade_level":"Grade 1","all_sections":true,"section_ids":[]}]'::jsonb);
    raise exception 'RLS: anon preview RPC was allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select to_regclass('codex_event_target_test.event_grade_targets')::text as draft_table,
       to_regprocedure('codex_event_target_test.save_grade_targeted_event(jsonb,uuid,jsonb,uuid)')::text as draft_rpc;
rollback;
select to_regnamespace('codex_event_target_test')::text as schema_after_rollback;
