# Student face-reference persistence

The LOCAL_GATE attendance engine still matches live 128-dimensional face
encodings against its in-memory references using the existing distance rule.
For each registered student, the trusted engine now persists one row per usable
stored image in `public.student_face_embeddings`. The local NPZ remains a fast
copy. `students.face_embedding` remains the arithmetic mean for compatibility.
The engine processes up to five images per person by default; confirm a
machine-local `MAX_IMAGES_PER_PERSON` override is set to `5` before backfill.

## Deployment order

1. Verify the target Supabase project reference. Apply
   `EVENTMONITORING/database/migrations/20261008_student_face_embeddings.sql`
   there first. Do not point a new engine at a database lacking the table/RPC.
2. Verify `student_face_embeddings` has RLS enabled, no `anon` or
   `authenticated` table privileges/policies, and only `service_role` can
   execute `replace_student_face_embedding_set`.
3. Back up the machine-local `face_encodings_cache.npz`. Deploy the updated
   attendance engine and registration scripts to the LOCAL_GATE machine.
4. Run an authorized forced face rebuild (`/trigger_rebuild` with `force: true`)
   while the engine is connected to Supabase Storage. This re-encodes the
   actual images and fills the individual rows. The old NPZ format does not
   record which image produced each encoding, so blindly copying cached
   vectors into numbered image slots is unsafe when an image was skipped.
5. Compare counts and fingerprints without printing vector values. For each
   registered student, report uploaded image count, encodable image count,
   stored row count, skipped/failed count, and whether the stored fingerprint
   matches current Storage metadata. A student with no encodable image needs
   review or re-registration; the prior database set is preserved.
6. Back up and remove the local NPZ, restart the engine, and confirm its
   student reference counts are restored from `student_face_embeddings`.
   Restore the backup if the test fails. Keep the camera covered so no
   attendance or gate record is created.

New registrations upload into a unique `registration_<random>` subfolder. The
student's path changes only after at least three images upload. This prevents
a partial re-registration from combining new numbered PNGs with old numbered
PNGs. Old Storage folders are retained; any eventual deletion needs a
separate reviewed retention procedure.

The replacement RPC validates a nonempty set of up to five finite 128D
vectors, locks the student row, checks the current dataset path, replaces the
old sample rows, and updates the average and fingerprint in one transaction.
If encoding or persistence fails, the engine keeps the prior references and
marks the sync partial for retry. It never fills missing slots with fake
vectors. Individual rows use the permanent `student_id` UUID, not `stud_id`.

The currently broad authenticated SELECT grant on `students` can expose the
legacy average column through existing student queries. This migration keeps
that grant unchanged to avoid breaking application pages. The new individual
table is private to the trusted server path. Restricting the legacy average
column should be a separately tested browser-query migration.

Development has no existing student face dataset or `facial_data` bucket. Its
automated integration test uses disposable student rows and synthetic vector
references; it verifies persistence, RLS, fingerprint changes, and cache
restoration, but is not a camera/real-face enrollment acceptance test.
