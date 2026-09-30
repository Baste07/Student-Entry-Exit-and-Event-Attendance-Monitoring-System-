-- DEVELOPMENT ONLY. Model registration/import inserts and edit updates.
-- All synthetic rows are rolled back.
begin;
do $$
declare
  v_year uuid := gen_random_uuid();
  v_section uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_kinder uuid := gen_random_uuid();
begin
  insert into public.school_years(id,name,start_date,end_date,is_active)
  values (v_year,'Grade Write Regression Fixture','2017-06-01','2018-03-25',false);
  insert into public.sections(section_id,grade_level,section_name,school_year_id)
  values (v_section,'Grade 4','Persistent Section Fixture',v_year);

  -- A legacy import that omits the grade, or sends NULL, cannot persist NULL.
  insert into public.students(student_id,stud_id,first_name,last_name,
      current_grade_level,section_id,school_year_id,status)
  values (v_student,'1-9871','GradeWriteFixture','One',null,v_section,v_year,'active');
  if (select current_grade_level from public.students where student_id=v_student)
       is distinct from 'Grade 1'
  then raise exception 'Valid ID insert persisted a NULL or mismatched grade'; end if;

  begin
    insert into public.students(student_id,stud_id,first_name,last_name,
        current_grade_level,section_id,school_year_id,status)
    values (gen_random_uuid(),'1-9872','GradeWriteFixture','Mismatch',
        'Grade 2',v_section,v_year,'active');
    raise exception 'Mismatched registration/import insert was accepted';
  exception when check_violation then null; end;
  begin
    update public.students set current_grade_level=null where student_id=v_student;
    raise exception 'Edit cleared current grade for a valid ID';
  exception when check_violation then null; end;
  begin
    update public.students set current_grade_level='Grade 2' where student_id=v_student;
    raise exception 'Edit mismatched grade and ID';
  exception when check_violation then null; end;
  update public.students set current_grade_level='Grade 1' where student_id=v_student;
  if not found then raise exception 'Matching edit failed'; end if;
  insert into public.students(student_id,stud_id,first_name,last_name,
      current_grade_level,section_id,school_year_id,status)
  values (v_kinder,'K-9871','GradeWriteFixture','Kinder',
      'Kinder',v_section,v_year,'active');
  if (select current_grade_level from public.students where student_id=v_kinder)
       is distinct from 'Kinder'
  then raise exception 'K-9871/Kinder insert failed'; end if;
end $$;
rollback;
