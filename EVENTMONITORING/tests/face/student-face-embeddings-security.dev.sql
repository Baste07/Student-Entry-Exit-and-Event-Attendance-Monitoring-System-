-- Read-only metadata assertions for the Development project.
do $$
begin
  if not (select relrowsecurity from pg_class
           where oid = 'public.student_face_embeddings'::regclass) then
    raise exception 'Student face embeddings RLS is disabled';
  end if;
  if has_table_privilege('anon', 'public.student_face_embeddings', 'SELECT')
     or has_table_privilege('authenticated', 'public.student_face_embeddings', 'SELECT')
     or has_table_privilege('authenticated', 'public.student_face_embeddings', 'INSERT')
     or has_table_privilege('authenticated', 'public.student_face_embeddings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.student_face_embeddings', 'DELETE')
     or has_function_privilege('anon',
          'public.replace_student_face_embedding_set(uuid,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated',
          'public.replace_student_face_embedding_set(uuid,text,text,jsonb)', 'EXECUTE') then
    raise exception 'Browser role can access protected student face references';
  end if;
  if not has_table_privilege('service_role', 'public.student_face_embeddings', 'SELECT')
     or not has_function_privilege('service_role',
          'public.replace_student_face_embedding_set(uuid,text,text,jsonb)', 'EXECUTE') then
    raise exception 'Trusted engine permissions are incomplete';
  end if;
end $$;
