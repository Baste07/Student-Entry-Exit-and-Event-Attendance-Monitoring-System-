# Students table least-privilege review (2026-09-29)

> Historical pre-deployment review. The student-security and rollover migrations were applied to production on 2026-09-30. Statements below about the undeployed production state describe the 2026-09-29 snapshot.

Production `hgdqarcdfycdesavwrvq` was queried read-only. Migration and policy tests were run only on development `ehyqvyglirirktfmdezq`. Neither student-security nor student-ID rollover migration was applied to production in this review.

## Production exposure

RLS is enabled, but four policies allow every authenticated user to SELECT, INSERT, UPDATE, or DELETE every student row (`USING true` / `WITH CHECK true`). Table-wide grants give `anon`, `authenticated`, and `service_role` SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER; column privilege inspection confirmed SELECT/INSERT/UPDATE for **all 19 current production columns** for `anon` and `authenticated`. No column-specific limit exists. `TRUNCATE` bypasses RLS. Anon has no permissive SELECT/write policy, but its unnecessary grants should still be removed. Any signed-in account, including ordinary or suspended Admins and other authenticated profiles, can currently alter student IDs, section, school year, status, face metadata, and any other student column, or delete/insert rows directly.

The existing active Admin security helper `app_private.is_active_super_admin()` checks `auth.uid()` against an active `admins` row. The admin-profile security migration already restricts promotion. The proposed student security policy uses this helper, including a restrictive boundary that another future permissive student policy cannot override for writes.

## Application write inventory

| Flow | Current path | Columns written | Intended authority |
| --- | --- | --- | --- |
| Single registration | `admin/student-import.js` | UUID, display ID, current grade, names, suffix, birth date, gender, section, school year, email, status, address, timestamps | Active Super Admin browser |
| Spreadsheet import | `admin/student-import.js` | Same core student fields; existing IDs updated, new rows inserted | Active Super Admin browser |
| Student edit/status | `admin/student-import.js` | Display ID, current grade, names, suffix, birth date, gender, section, email, status, updated timestamp | Active Super Admin browser |
| Student deletion | `admin/student-import.js` | DELETE after related rows are removed | Active Super Admin browser; related-table policies remain separate |
| Face registration | `students/face_capture.py`; legacy `students/manual_registration.py` | `facial_dataset_path` | Local service-role Python service |
| Attendance face cache | `students/flask_attendance.py` | `face_embedding`, `face_embedding_fingerprint` | Local service-role Python service |
| QR issuance/reissue | `admin/system-settings.js`, `admin/student-import.js`, `resc/js/qrAttendance.js`, `resc/js/sendQrCodes.js` | Student rows read; no student UPDATE found. Rollover QR queue is written through its own RPC. | Read-only student access; Super Admin queue marking |
| Annual rollover | `student_rollover_private.perform` | `stud_id`, `current_grade_level`, `school_year_id` together; UUID and section untouched | Transactional privileged database function |
| Event and Entry & Exit | Event participant selection, gate scans/logging, analytics/reports | Student rows read; attendance/log writes target other tables | Read-only student access |

The active `SUPABASE_KEY` for the local Python face service was inspected **only for its role**, without printing its value: it is a service-role key. It must stay server-side. Browser `accountRegistration.js` reads the student row and calls the local face service; it does not directly update face fields. Some older `sendQrCodes.js` selects columns absent from the current student schema, an existing compatibility issue outside this security migration.

## Proposed grants and policies

`20260927_students_security.sql` revokes all table and per-column grants from `PUBLIC`, `anon`, and `authenticated`; keeps existing `service_role` grants; grants authenticated SELECT for read-dependent pages, Super Admin-scoped INSERT/UPDATE/DELETE, and only the explicit browser write columns. It never grants browser UPDATE on immutable `student_id`, `facial_dataset_path`, `face_embedding`, `face_embedding_fingerprint`, or `profile_picture`. It removes browser `TRUNCATE`, `REFERENCES`, and `TRIGGER`. RLS SELECT stays available to authenticated readers; INSERT, UPDATE, and DELETE each have Super Admin permissive and restrictive policies. Active normal and suspended Admins have no student write path. Anon has no table access.

The security migration works before or after the rollover migration. If installed before, the rollover migration grants INSERT/UPDATE only on its new `current_grade_level` column; the existing Super Admin RLS boundary still controls those writes. The privileged rollover function updates the three academic fields without broad browser UPDATE grants. The production schema has optional columns that the synthetic development fixture omits; the grant migration intersects the explicit allowlist with columns actually present. Unknown future columns receive no browser write grant.

## Development results

The migration applied successfully to the development project. Metadata showed no anonymous table grants, no authenticated TRUNCATE, no browser UPDATE on UUID or face path, and only the reviewed authenticated INSERT/UPDATE columns. The development fixture has one additional permissive read policy (`Fixture read students`); its presence does not weaken the restrictive write boundary and is not in production.

Rolled-back synthetic tests passed for active normal Admin, suspended Admin, active Super Admin, and service role. Normal and suspended Admins could not update protected or ordinary student fields, insert, or delete. Browser UPDATE of UUID/face path was denied even for Super Admin. Super Admin registration, edit/status, and deletion succeeded. Service-role face-path update succeeded. After the security migration, the complete rollover migration reran successfully; rollover smoke, two-identity authorization, and atomicity tests passed, and metadata still showed one Cron job. The separate pre-install backfill test cannot be rerun against the now-installed development fixture because its synthetic pre-install student was cleaned up; it passed during the prior clean-install sequence.

## Remaining deployment risks

- Production has 19 student columns; the development fixture has 15. The migration is designed for both, but a production pre-deploy grant diff and post-deploy browser smoke remain necessary.
- Authenticated SELECT still reads all student columns, including face metadata, to avoid breaking existing `select('*')` paths. A separate column-level read/privacy review is warranted.
- Student deletion also deletes related records directly in the browser. Those other tables' policies are outside this migration and need a separate review.
- The school's clarified rule makes `stud_id` authoritative: `1-0016`, `1-0018`, and `1-0034` are Grade 1. Their section-grade differences are informational, and production rows remain untouched until an approved migration.
- Physical face scanner, QR device, browser login, and live scheduled Cron behavior have not been tested here.

## Final compatibility check (2026-09-30)

The exact final rollover migration was clean-installed and rerun on development **after** the student-security migration. Active normal and suspended Admin writes were denied; active Super Admin registration/edit/status/delete and service-role face-path updates passed. The privileged rollover still updated academic fields transactionally without granting the browser broad table UPDATE. Production remains read-only and still has 19 student columns; development has 15 after the new grade column. The five production-only fields are `suffix`, `address`, `profile_picture`, `face_embedding`, and `face_embedding_fingerprint`. `suffix` and `address` are in the intended Super Admin browser INSERT/UPDATE allowlist. The picture and face embedding fields are not browser writes; their authenticated SELECT remains available and service-role writes remain granted. Production would have 20 columns after the grade migration. A development browser login, Student Import and Entry/Exit Grade 1/2 filtering, and authenticated UUID QR lookup passed. Full data-backed browser workflows and physical devices still require post-deployment smoke tests.
