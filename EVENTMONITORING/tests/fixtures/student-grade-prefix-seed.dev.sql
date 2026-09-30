-- Development only; remove with student-grade-prefix-cleanup.dev.sql.
begin;
do $$ begin
  if exists(select 1 from public.students where stud_id in
    ('1-0016','1-0018','1-0034','K-8003','2-8004','10-8005','1-8006')) then
    raise exception 'Fixture Student ID collision';
  end if;
end $$;
insert into public.school_years(id,name,start_date,end_date,is_active) values
 ('00000000-0000-4000-8000-000000008000','2017-2018 Grade Prefix Fixture','2017-06-01','2018-03-31',false),
 ('00000000-0000-4000-8000-000000008001','2018-2019 Grade Prefix Fixture','2018-06-01','2019-03-31',false);
insert into public.sections(section_id,grade_level,section_name,school_year_id) values
 ('00000000-0000-4000-8000-000000008104','Grade 4','Fixture A','00000000-0000-4000-8000-000000008000'),
 ('00000000-0000-4000-8000-000000008102','Grade 2','Fixture B','00000000-0000-4000-8000-000000008000'),
 ('00000000-0000-4000-8000-000000008106','Grade 6','Fixture C','00000000-0000-4000-8000-000000008000'),
 ('00000000-0000-4000-8000-000000008100','Kinder','Fixture K','00000000-0000-4000-8000-000000008000'),
 ('00000000-0000-4000-8000-000000008110','Grade 10','Fixture 10','00000000-0000-4000-8000-000000008000');
insert into public.students(student_id,stud_id,first_name,last_name,section_id,school_year_id,status) values
 ('00000000-0000-4000-8000-000000008016','1-0016','GradePrefixFixture','Sixteen','00000000-0000-4000-8000-000000008104','00000000-0000-4000-8000-000000008000','active'),
 ('00000000-0000-4000-8000-000000008018','1-0018','GradePrefixFixture','Eighteen','00000000-0000-4000-8000-000000008102','00000000-0000-4000-8000-000000008000','active'),
 ('00000000-0000-4000-8000-000000008034','1-0034','GradePrefixFixture','Thirty Four','00000000-0000-4000-8000-000000008106','00000000-0000-4000-8000-000000008000','active'),
 ('00000000-0000-4000-8000-000000008003','K-8003','GradePrefixFixture','Kinder','00000000-0000-4000-8000-000000008100','00000000-0000-4000-8000-000000008000','active'),
 ('00000000-0000-4000-8000-000000008004','2-8004','GradePrefixFixture','Two','00000000-0000-4000-8000-000000008102','00000000-0000-4000-8000-000000008000','active'),
 ('00000000-0000-4000-8000-000000008005','10-8005','GradePrefixFixture','Ten','00000000-0000-4000-8000-000000008110','00000000-0000-4000-8000-000000008000','active'),
 ('00000000-0000-4000-8000-000000008006','1-8006','GradePrefixFixture','Inactive','00000000-0000-4000-8000-000000008104','00000000-0000-4000-8000-000000008000','inactive');
-- Existing development insert trigger fills the field; clear it to emulate
-- pre-install rows, then rerun the actual migration.
update public.students set current_grade_level=null where first_name='GradePrefixFixture';
do $$ begin
  if (select count(*) from public.students where first_name='GradePrefixFixture'
      and current_grade_level is null)<>7 then raise exception 'Fixture preparation failed'; end if;
end $$;
commit;
