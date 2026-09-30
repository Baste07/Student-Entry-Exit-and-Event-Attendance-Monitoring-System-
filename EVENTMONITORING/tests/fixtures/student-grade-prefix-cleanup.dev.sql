-- Development only. Remove only the exact synthetic prefix-backfill fixture.
begin;
do $$ begin
  if (select count(*) from public.students
      where first_name='GradePrefixFixture'
        and student_id in ('00000000-0000-4000-8000-000000008016'::uuid,
                           '00000000-0000-4000-8000-000000008018'::uuid,
                           '00000000-0000-4000-8000-000000008034'::uuid,
                           '00000000-0000-4000-8000-000000008003'::uuid,
                           '00000000-0000-4000-8000-000000008004'::uuid,
                           '00000000-0000-4000-8000-000000008005'::uuid,
                           '00000000-0000-4000-8000-000000008006'::uuid))<>7 then
    raise exception 'Fixture differs from expected; cleanup stopped'; end if;
end $$;
delete from public.students where first_name='GradePrefixFixture'
 and student_id in ('00000000-0000-4000-8000-000000008016',
                    '00000000-0000-4000-8000-000000008018',
                    '00000000-0000-4000-8000-000000008034',
                    '00000000-0000-4000-8000-000000008003',
                    '00000000-0000-4000-8000-000000008004',
                    '00000000-0000-4000-8000-000000008005',
                    '00000000-0000-4000-8000-000000008006');
delete from public.sections
 where school_year_id='00000000-0000-4000-8000-000000008000'
   and section_id in ('00000000-0000-4000-8000-000000008104',
                      '00000000-0000-4000-8000-000000008102',
                      '00000000-0000-4000-8000-000000008106',
                      '00000000-0000-4000-8000-000000008100',
                      '00000000-0000-4000-8000-000000008110');
delete from public.school_years
 where id in ('00000000-0000-4000-8000-000000008000',
              '00000000-0000-4000-8000-000000008001')
   and name like '%Grade Prefix Fixture';
commit;
