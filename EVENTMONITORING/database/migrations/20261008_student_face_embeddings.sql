-- Permanent, per-image student face references. Apply to Development first.
-- Production already has the two students.face_* columns; the conditional
-- additions bring older Development fixtures to the same representation.
begin;

create extension if not exists vector with schema public;

alter table public.students
  add column if not exists face_embedding public.vector(128),
  add column if not exists face_embedding_fingerprint text;

do $$
begin
  if (select format_type(a.atttypid, a.atttypmod)
        from pg_attribute a
       where a.attrelid = 'public.students'::regclass
         and a.attname = 'face_embedding' and not a.attisdropped) <> 'vector(128)' then
    raise exception 'students.face_embedding must be vector(128)';
  end if;
end $$;

create table if not exists public.student_face_embeddings (
  embedding_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(student_id) on delete cascade,
  image_slot smallint not null check (image_slot between 1 and 5),
  embedding public.vector(128) not null,
  source_image_name text not null,
  source_image_path text not null,
  dataset_fingerprint text not null check (dataset_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_face_embeddings_slot_key unique (student_id, image_slot),
  constraint student_face_embeddings_image_key unique (student_id, source_image_name)
);

create index if not exists student_face_embeddings_student_id_idx
  on public.student_face_embeddings (student_id);

alter table public.student_face_embeddings enable row level security;
revoke all on public.student_face_embeddings from public, anon, authenticated;
grant select, insert, update, delete on public.student_face_embeddings to service_role;

-- SECURITY INVOKER: only service_role can execute and access the protected table.
-- One RPC call is one Postgres transaction: either every sample and the average
-- are changed, or the previous valid set remains untouched.
create or replace function public.replace_student_face_embedding_set(
  p_student_id uuid,
  p_dataset_path text,
  p_fingerprint text,
  p_samples jsonb
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_path text;
  v_count integer;
  v_average public.vector(128);
begin
  if p_student_id is null or p_dataset_path is null or p_dataset_path = ''
     or p_fingerprint !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_samples) is distinct from 'array'
     or jsonb_array_length(p_samples) not between 1 and 5 then
    raise exception 'Invalid student face embedding set';
  end if;

  select facial_dataset_path into v_current_path
    from public.students where student_id = p_student_id for update;
  if not found or v_current_path is distinct from p_dataset_path then
    raise exception 'Student face dataset path changed';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_samples)
      as s(image_slot integer, source_image_name text, embedding text)
    where s.image_slot is null or s.image_slot not between 1 and 5
       or s.source_image_name is null
       or s.source_image_name !~* '^[a-z0-9._-]+\.(png|jpg|jpeg)$'
       or s.embedding is null
  ) then
    raise exception 'Invalid student face image entry';
  end if;

  delete from public.student_face_embeddings where student_id = p_student_id;
  insert into public.student_face_embeddings
    (student_id, image_slot, embedding, source_image_name,
     source_image_path, dataset_fingerprint)
  select p_student_id, s.image_slot, s.embedding::public.vector(128),
         s.source_image_name, p_dataset_path || '/' || s.source_image_name,
         p_fingerprint
    from jsonb_to_recordset(p_samples)
      as s(image_slot integer, source_image_name text, embedding text);

  select count(*), public.avg(embedding) into v_count, v_average
    from public.student_face_embeddings where student_id = p_student_id;
  update public.students
     set face_embedding = v_average,
         face_embedding_fingerprint = p_fingerprint
   where student_id = p_student_id;
  return v_count;
end $$;

revoke all on function public.replace_student_face_embedding_set(uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_student_face_embedding_set(uuid,text,text,jsonb)
  to service_role;

commit;
