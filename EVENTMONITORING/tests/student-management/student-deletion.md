# Student deletion

Production catalog reviewed on 2026-10-27 (Manila). Primary key: `students.student_id` (UUID); `stud_id` is a mutable display identifier.

| Relationship | Existing policy | RPC behavior |
| --- | --- | --- |
| sms_notifications.student_id | NO ACTION | Delete student-specific messages |
| daily_attendance.student_id | NO ACTION | Delete student attendance |
| event_attendance.student_id | NO ACTION | Delete student event attendance |
| student_guardians.student_id | NO ACTION | Delete links; keep guardians |
| spoof_attempts.student_id | NO ACTION | Delete student spoof attempts |
| face_registration_logs.student_id | NO ACTION | Move UUID to deleted_student_id, clear live reference; retain audit row |
| event_participants.student_id | CASCADE | Explicitly delete student participation |
| student_face_embeddings.student_id | CASCADE | Existing cascade deletes stored vectors |
| entry_exit_logs.student_id | SET NULL | Explicitly delete student gate attendance, consistent with confirmation |
| gate_sms_notifications.student_id | SET NULL | Explicitly delete student delivery state |
| gate_sms_notifications.entry_exit_log_id | CASCADE | Existing cascade handles log-linked delivery state |
| student_id_rollover_qr_queue.student_id | No FK | Delete pending work |
| student_id_rollover_changes.student_id | No FK, historical identifier | Keep immutable rollover history |

The complete production FK catalog found no additional incoming dependencies on these children. Public columns named student_id/stud_id were also inspected. No lab enrollment/attendance tables exist in the inspected production schema. Shared events, guardians, sections, school years, employees, other students and generic system audit history remain intact. No FK policy is changed or disabled. Unknown future blocking constraints fail the transaction rather than silently dropping unknown data.

Registration logs originally require exactly one live student or employee reference. The migration adds a historical deleted_student_id UUID and adjusts that CHECK to also permit exactly one historical student reference, allowing retention without a broken FK or losing audit identity.

`public.delete_student(uuid)` is an invoker wrapper around a private definer with an empty search_path and qualified objects. The private function checks auth.uid() and the existing active, unlocked, AAL2 Super Admin predicate. PUBLIC/anon execution is revoked; authenticated direct student DELETE is revoked. The UUID row lock serializes repeat requests; missing students return deleted=false. Any SQL error rolls back every child operation.

Run UI regressions with `node --test EVENTMONITORING/tests/student-management/*.test.cjs`. Run isolated SQL checks from PowerShell with `EVENTMONITORING/tests/student-management/run-student-deletion-dev.ps1`. This refuses any linked project except the reviewed development project and rolls back fixtures, supplemental production-shaped relationship tables, migration code, and grants in one transaction. It never deletes production fixtures or real students.

Apply the migration before deploying the updated frontend. The migration installs code and grants only, with no student cleanup. Existing open browser tabs must reload; the updated page uses a new script version. No privileged credentials are added to browser code.

Storage image files and workstation face caches are outside this database transaction and are not claimed to be erased by this workflow. Database profile vectors and per-image embeddings are removed. Separate existing storage/cache retention remains unchanged.
