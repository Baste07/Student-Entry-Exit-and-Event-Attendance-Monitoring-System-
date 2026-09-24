# Project context (source-code snapshot)

This document describes the code under `EVENTMONITORING/` as inspected on 2026-09-24. It is a map of **implemented source code**, not proof that every service, table, policy, external provider, or feature works in a deployed environment. `CAPSTONEFINAL/` is the Git root; `EVENTMONITORING/` is the application root. The sibling `TEST/` is local and outside the application described here. No credential values are included. Relative paths below start at the Git root unless noted otherwise.

## 1. System Overview

The pages call the application a Monitoring System / Entry-Exit Attendance system; the Windows launchers also use “SAMS.” The code implements a school administration and attendance application: super admins manage accounts, staff, students, school years, sections and audit views; an event/laboratory area manages events, participants, face enrollment, event attendance and reports; a school gate area records student and employee entry/exit by face, student QR, or manual input. A portal selects module cards. The frontend is multipage HTML/CSS/vanilla JavaScript served through XAMPP/Apache, with some Bootstrap 5 pages and CDN libraries. Supabase JS and Python clients access Auth, Postgres tables and the `facial_data` Storage bucket. PHP provides launch, email and privileged account endpoints. Two local Flask/OpenCV services handle face registration (port 5001) and recognition/attendance (port 5000).

**Status:** These flows exist in source. Runtime availability, a complete deployed database schema, provider delivery, and end-to-end operation are **UNKNOWN** from this repository review. Several portal role branches and older flow-document claims exceed the current login/backend implementation; see §21.

## 2. Project Folder Structure

```text
CAPSTONEFINAL/                         Git root; this document
├── EVENTMONITORING/                    application root
│   ├── index.html                      landing/redirect page
│   ├── auth/                           login, registration, password reset
│   ├── portal/                         module selection
│   ├── admin/                          super-admin pages, JS/CSS, PHP endpoints
│   ├── config/                         browser Supabase setup; server PHP client
│   ├── shared/                         audit/session helpers and logout dialog
│   ├── database/migrations/            local SQL for SMS setting
│   ├── TimeInAndTimeOutMonitoring/      event/lab UI and face services
│   │   ├── admin/                      event, lab, attendance/report pages
│   │   ├── students/                   scanner/registration UI, Python, PHP, BAT
│   │   ├── resc/js/ and resc/css/      page-specific scripts/styles
│   │   ├── includes/                   fetched header/sidebar and loader
│   │   └── src/                        Silent-Face anti-spoof code
│   ├── EntryExitMonitoring/            school gate UI and reports
│   │   ├── gate/                       face/QR/manual scanner page
│   │   ├── admin/                      dashboard, logs, people, settings, reports
│   │   ├── resc/js/ and resc/css/      page-specific scripts/styles
│   │   └── includes/                   fetched header/sidebar and loader
│   ├── tests/                           PHP test for admin deletion
│   └── Gemma/                           standalone Ollama-backed FAQ demo
└── TEST/                                local sibling, not a main application module
```

`TimeInAndTimeOutMonitoring/` is named for time tracking but houses the **event and laboratory** module as well as the shared face engine. `EntryExitMonitoring/` is the school gate module. The nested `students/` service folder contains more than student-only code. Other portal card names refer to modules whose implementations are not present here.

`Gemma/main.py` contains an FAQ prompt describing some such absent modules; that prompt is not evidence that they exist.

## 3. Main Modules

### Super Admin

`admin/usermanagement.html` / `.js` manage `admins`: list/search/filter, create/edit, suspend/reactivate and delete. Deletion calls `admin/delete-admin.php`, which validates a Supabase bearer token and active super-admin profile, prevents self-deletion, then deletes Auth and remaining profile data. `admin/teachermanagement.*` manages `employees` and CSV-style bulk import. `admin/student-import.*` handles single student registration, spreadsheet import, guardians, links, QR/email, search/edit/delete; `admin/admin-section-management.*` and `admin/admin-subjects.*` manage academic data. `admin/system-settings.*` manages `school_years` and the `system_settings.sms_enabled` switch. `admin/audit-logs.html` and `admin/spoof-attempts.html` expose operational views. These pages use custom forms/dialogs and Bootstrap styling on some pages. They depend on Supabase Auth/data, shared session/audit code, and records read by event/gate modules.

### Event and laboratory module

`TimeInAndTimeOutMonitoring/admin/events.html` + `resc/js/events.js` create/update/delete dated events, select participants by grade/section or individual, detect time overlap, and update status (`upcoming`, `ongoing`, `completed`, `cancelled`) from dates and time. Explicit participant rows go to `event_participants`. The face attendance page `students/takeAttendance.html` + `resc/js/takeAttendance.js` chooses the Flask `event_attendance` mode, displays MJPEG and SSE feedback. `students/flask_attendance.py` determines an eligible event from a recognized student's participant rows, inserts `event_attendance.time_in` for an ongoing event, and adds `time_out` after completion. `admin/eventAttendance.html`, `attendanceReports.html`, `eventAttendanceTrends.html`, and related JS show records, trends and exports. `resc/js/manualAttendance.js` provides manual event time-in/out and email. The same module also contains lab schedules/enrollments/sessions, `lab_attendance`, and `las_reports` pages; this is a distinct attendance data path, not the face event table.

### Entry and Exit module

`EntryExitMonitoring/gate/entryExitScanner.html` + `resc/js/entryExitScanner.js` offer face, student QR (`Html5Qrcode`) and manual logging. Face mode sets `/scanner_mode` to `entry_exit`, shows `/video_feed`, and listens to `/attendee_stream`. In this mode Flask records `entry_exit_logs` and emits `gate_recorded`; JS displays a result overlay. QR/manual paths query people and insert logs directly with Supabase JS. `admin/dashboard.html`, `entry-exitLogs.html`, `students.html`, `employees.html`, `settings.html`, and `reports.html` show records, gate options and exports. `gate_settings` supplies JS options such as cooldown, automatic alternating entry/exit and late threshold. Face-gate recording is currently implemented in Python and does not use those JS settings; see §21.

## 4. User Roles and Permissions

**Implemented login:** `auth/login.js` authenticates email/password with Supabase Auth, then requires an active matching `admins` row. It stores an admin profile in `sessionStorage.user` and routes to the portal. `AUTH_DISABLED` is `false`; hardcoded fallback admin profiles/passwords exist in code but the bypass branch is currently disabled. Super admin (`admin_level=super_admin`) receives portal access to super-admin, event and gate cards; regular admin receives event and gate cards. Super-admin UI controls hide/restrict functions for other admins. `delete-admin.php` additionally enforces active super-admin status on the server.

**Other role references:** `portal/portal.js` contains student, professor/faculty/dean branches; `auth/register.js` creates pending `professors` Auth/profile records; face matching distinguishes students and teacher employees. Student QR/face scans do not establish a browser login. The current `loginUser()` verifies only `admins`, so end-to-end browser login and protected page access for student/professor roles are **NOT CONFIRMED**. `employees.role=teacher` is used by the face engine. “Event staff” is **NOT FOUND** as a separate enforced role. Session/sidebar access checks are client-side on many pages; deployed RLS coverage beyond the local migration is **UNKNOWN**.

## 5. Frontend Architecture

Pages are independent HTML documents with matching `resc/js/*.js` and `resc/css/*.css` in the two monitoring modules; super-admin pages mostly keep HTML/JS/CSS together in `admin/`. `includes/sidebar.js` fetches `includes/header.html` and `sidebar.html` into container elements on event and gate admin pages. `admin/admin-specific.js` builds the super-admin navigation/header. The portal links to documents, rather than mounting a single-page app. `resc/js/iframe.js` exists, but the main inspected module pages load directly; an application-wide iframe shell is **NOT FOUND**. Bootstrap 5 is loaded on portal and selected admin pages; many event/gate dialogs are custom CSS/JS. Other CDN dependencies visible in pages include Font Awesome, Chart.js, XLSX, jsPDF/AutoTable and html5-qrcode. Header/sidebar markup and page-level utilities are partially duplicated across modules.

## 6. Modal, Alert, Toast, and Feedback System

There is **no single global feedback API**. `shared/logout-modal.js` and `.css` centralize logout confirmation, but pages define their own dialogs and toasts. Native `alert()` / `confirm()` still occur in account management, imports/settings, schedules/reports and several event/lab scripts. For example, `admin/system-settings.js` confirms school-year activation; `admin/usermanagement.js` confirms deletion and uses alerts for its outcome; `resc/js/attendanceGraphs.js` confirms duplicate exports. Inline validation exists in event/student forms, and engine/import flows show loading/skeleton states.

**Feature modals:** admin add/edit account and teacher dialogs; student single-registration, import preview and guardian forms; event creation/editing and participant picker; gate manual entry; event/manual attendance forms. Some are Bootstrap markup/controllers, others are custom overlays.

**Feedback modals/overlays:** logout confirmation; event overlap/validation feedback; face registration progress; attendance greeting, spoof and multi-face warnings, and face-database sync summary in `takeAttendance.html`; corresponding gate result/spoof/multi-face/sync overlays in `entryExitScanner.html`. Page-specific `showToast`, `showAlert`, status strips and error text repeat. Do not assume every element named “modal” is a Bootstrap `Modal`; inspect the page and its script before changing asynchronous confirmation behavior.

## 7. JavaScript Architecture

`config/config.js` creates the browser `supabaseClient`; `shared/global.js` provides `getCurrentUser`, `isSuperAdmin`, `isAdmin`, `isProfessor`, route/audit helpers, and `logSystemAudit`. `shared/logout-modal.js` signs out and clears session state. `portal/portal.js` filters module cards. Each page script initializes from `DOMContentLoaded` or top-level listeners, owns its local DOM state, and calls Supabase directly. Important scripts: `admin/usermanagement.js`, `teachermanagement.js`, `student-import.js`, `system-settings.js`; event `events.js`, `manualAttendance.js`, `takeAttendance.js`, `accountRegistration.js`, `laboratorySessions.js`, `attendanceReports.js`, `attendanceGraphs.js`; gate `entryExitScanner.js`, `entry-exitLogs.js`, `reports.js`, `settings.js`. Many scripts expose top-level functions for inline HTML handlers. Repeated helper names such as `showToast`, `escapeHtml`, date formatting, and load/render/filter functions are generally page-local, not shared modules. SSE (`EventSource`) is used for live scanner feedback; periodic fetches check engine status; Supabase JS handles most CRUD directly. No shared client-side state manager is found beyond globals and `sessionStorage`.

## 8. Supabase Architecture

Browser pages load Supabase JS v2, `config/.env.js`, then `config/config.js`; `config.js` creates one client **per page load** with persistent/refreshed Auth. The config values are intentionally omitted here. Python services create a `supabase-py` client from environment variables; PHP `config/supabase-server.php` obtains a server-only service key for privileged admin deletion. **Storage bucket confirmed in code:** `facial_data`; images are uploaded/listed/downloaded there. Student/employee rows point to dataset folders through `facial_dataset_path`; the attendance engine may store 128-dimensional `face_embedding` plus fingerprint in their rows and a local cache.

**Confirmed table names referenced by source (not a verified live schema):**

| Area | Tables and apparent purpose |
| --- | --- |
| Accounts/organization | `admins` (administrator profile/level/status), `employees` (teacher/employee identity), `professors` (registration/profile), `departments` (faculty metadata), `teachers` (legacy/parallel teacher reads) |
| Student/academic | `students` (identity, status, section, face path), `sections` (grade/section), `school_years` (academic calendar), `semesters`, `subjects`, `guardians` (contacts), `student_guardians` (student-contact links) |
| Event | `events` (date/time/status/targeting), `event_participants` (event-student links), `event_attendance` (time-in/out) |
| Laboratory | `laboratory_rooms`, `lab_schedules`, `schedule_enrollments`, `lab_sessions`, `lab_attendance`, `las_reports` (export/history rows) |
| Gate/other attendance | `entry_exit_logs` (gate movements), `gate_settings` (gate UI options), `daily_attendance` (student pages), `attendance_reports` (saved report metadata) |
| Operations | `system_settings` (SMS switch), `system_audit_logs`, `spoof_attempts`, `sms_notifications` (referenced in student deletion cleanup; creation/use otherwise not established) |

Confirmed operations include SELECT, INSERT, UPDATE, DELETE and upsert through `.from()`/`.table()` across the scripts and services. Examples: `events.js` inserts `events`/`event_participants` and deletes related event rows; Flask inserts/updates `event_attendance` and `entry_exit_logs`; `system-settings.js` upserts `system_settings`. **Realtime Postgres subscriptions and Supabase RPC calls: NOT FOUND** in application code scanned; browser SSE is Flask, not Supabase Realtime. The repository contains only one SQL migration, `database/migrations/20260924_system_settings_sms.sql`, defining `system_settings` and its RLS policies. Other table DDL, foreign keys, all deployed RLS policies, and bucket policy configuration are **UNKNOWN** here. The migration file's presence alone does not establish deployment.

## 9. Database Relationships

The code establishes logical links: `students.section_id` → `sections`; `students.student_id` ↔ `student_guardians.student_id` ↔ `guardians.guardian_id`; `events.event_id` → `event_participants.event_id` + `event_attendance.event_id`; `students.student_id` → participation/attendance; `lab_schedules` → `schedule_enrollments` → `lab_sessions`/`lab_attendance`; and student/employee IDs → `entry_exit_logs`. Supabase nested selections such as `students(..., sections(...))` show that some relationship is available to the Data API. Exact SQL foreign-key constraints, uniqueness and cascading behavior are **UNKNOWN** because full schema DDL is absent. `delete-admin.php` explicitly handles both cascading and non-cascading Auth/profile deletion.

## 10. Facial Recognition Architecture

`students/face_capture.py` (registration) uses OpenCV camera frames, dlib/`face_recognition` HOG detection, alignment/stability checks and MediaPipe segmentation support; it collects multiple acceptable face images, uploads them into `facial_data/students/...` or a professor folder, then updates a profile's `facial_dataset_path`. `resc/js/accountRegistration.js` controls the registration service and checks bucket files. `students/flask_attendance.py` loads face images from Storage and computes `face_recognition.face_encodings` (128-D). It maintains a versioned `face_encodings_cache.npz` with per-person fingerprints, saves it via temporary file plus atomic replacement, and refreshes it from Supabase. It also writes `face_embedding`/`face_embedding_fingerprint` fields where possible. Recognition crops a guide ROI, resizes to 25%, detects faces using HOG, rejects frames with more than one face before encoding, then matches 128-D vectors by Euclidean distance; accepted distance is **< 0.40**. Unknown faces remain unrecorded. A 5-second Python per-person cooldown reduces repeated face events.

**Anti-spoofing: IMPLEMENTED CONDITIONALLY.** The attendance service loads Silent-Face/MiniFASNet `.pth` models through `src/anti_spoof_predict.py` when enabled and available. It crops the detected face, combines model live scores and compares with configurable threshold (default `0.5`); default fail-closed behavior blocks when required models are unavailable. Blocked attempts produce a spoof event/log. Actual model-file presence and successful runtime inference are **UNKNOWN** from code inspection. `students/eval_liveness.py`, `evaluate_face_recognition.py`, `research_results_graphs.py`, and `pythonvisuals/` are evaluation/demo support, not the active scanner path. Both Flask services coordinate ownership through local `camera_owner.json`; registration and attendance use separate localhost ports.

## 11. Python / Flask Services

| Service | Port and implemented endpoints | Main inputs/outputs |
| --- | --- | --- |
| `students/face_capture.py` | `127.0.0.1:5001`: `POST /start_registration`, `GET /status`, `GET/POST /camera_control`, `GET /video_feed`, `POST /pipeline_snapshot`, `GET /pipeline_snapshot_image/<filename>`, `POST /shutdown`, `GET /` | Registration JSON includes ID, names, role; status/camera/snapshot return JSON; video is MJPEG. Uploads image files to Supabase Storage and updates profile path. |
| `students/flask_attendance.py` | `127.0.0.1:5000`: `GET /attendee_stream`, `/video_feed`, `/engine_status`, `GET/POST /camera_control`, `GET/POST /scanner_mode`, `POST /trigger_rebuild`, `POST /shutdown`, `GET /scanner`, `/`, `/ongoing_events`, `/email_status`, `/email_status/latest`, `/sms_status`, `/sms_status/latest` | SSE sends JSON recognition/attendance messages; video is MJPEG; mode POST JSON selects `event_attendance` or `entry_exit`; rebuild POST may require a token; status/diagnostic routes return JSON. Performs Supabase reads/writes and queues email/SMS work. |

`students/sms_notifications.py` is a helper, not a Flask service. `students/manual_registration.py` is a separate manual/research registration script, not the route used by `accountRegistration.js`. `students/START_ATTENDANCE.BAT`, `START_REGISTRATION.bat`, `START.SILENT.bat`, and `STOP_ENGINE.bat` launch/stop local Python processes; PHP `trigger_attendance.php` and `trigger_registration.php` launch BAT files from XAMPP. They contain machine-specific paths; `STOP_ENGINE.bat` targets all `pythonw.exe` processes, not just this application's engines. `students/send_event_attendance_email.php` and `admin/send-student-qr-email.php` handle JSON POST email delivery using PHPMailer/config. `students/machine_lab_config.php` serves a local JSON configuration. Important **variable names only**: `SUPABASE_URL`, `SUPABASE_KEY`, server-only `SUPABASE_SERVICE_ROLE_KEY`, `CAMERA_INDEX`, `REBUILD_SECRET`, `IPROG_API_URL`, `IPROG_API_TOKEN`, anti-spoof/cache settings. Actual values are [REDACTED].

`Gemma/main.py` is a separate standard-library `HTTPServer` FAQ proxy to local Ollama (`gemma:2b`); its `/chat` use is visible in `Gemma/index.html`. It also binds localhost port **5000**, conflicting with the attendance Flask service if both are started on the same machine. The main module pages do not call that chat endpoint.

Other important HTTP endpoints are PHP: `admin/delete-admin.php` accepts POST with a bearer token and JSON `adminId`, and returns JSON status/message; `students/send_event_attendance_email.php` accepts JSON POST attendance/event/email fields and returns JSON success/error; `admin/send-student-qr-email.php` accepts POST for QR email; `students/machine_lab_config.php` handles GET/POST for a local JSON file. The two trigger PHP files return JSON launch status. These are separate Apache routes, not Flask blueprints.

## 12. Attendance Logic

**Face event path:** start attendance engine; choose event mode; Flask detects one face in the guide, encodes/matches it, runs liveness, applies cooldown, resolves the student and checks `event_participants`. It chooses an ongoing event for time-in, else a completed event with an existing time-in for time-out, else reports upcoming/no match/no action. An existing row prevents repeat time-in; existing time-out prevents another completion. It writes `event_attendance`, queues email and SMS separately, emits SSE to the page, and the page shows greeting/toast. The code's 15-minute grace is for late calculation, not a generic scan acceptance window. Manual event attendance uses `manualAttendance.js` to inspect state and insert/update the same table, with its own email request. A QR scanner exists on the school gate page, **not** as the face event attendance mechanism.

**Gate path:** face mode uses Flask recognition and writes `entry_exit_logs`; QR/manual paths write the same table from JS. Gate face cooldown is 5 seconds in Python; JS keeps a separate configurable/default 10-second UI cooldown. Alternating entry/exit is by latest log in Python face mode; QR/manual JS uses today's latest log if `gate_settings.autoExit` is on. Classroom/lab attendance uses `lab_sessions`/`lab_attendance` and its own controls, not `event_attendance`. `daily_attendance` is queried by student pages; a complete writer for that table was **NOT CONFIRMED** in the inspected active face/gate flow.

## 13. Event Attendance Logic

An admin saves an event (date/time, optional end date, target grades/sections or selected student IDs) through `events.js`. It derives participant rows and computes status from clock/date; status updates are written from the page, so timely transition depends on page logic running or another unverified mechanism. The scanner reads stored statuses, prioritizes an `ongoing` participant event for time-in, then a `completed` event with missing time-out, then gives upcoming/no-action feedback. It stores `event_id`, `student_id`, time and remarks in `event_attendance`; late minutes derive from event start with grace. The reports/trends pages read `events`, `event_participants`, and/or `event_attendance` and render filtered tables/charts. Manual event attendance shares the table but is a separate JS path. The code does not prove a database transaction or uniqueness constraint around duplicate checks; concurrency guarantees are **UNKNOWN**.

## 14. Entry and Exit Logic

**Face:** gate operator starts the shared attendance engine → JS requests `entry_exit` scanner mode → Python captures a frame → HOG detection/one-face gate → encoding and distance match → liveness check → `_record_gate_log` reads the most recent person log, alternates entry/exit, inserts `entry_exit_logs`, queues student guardian SMS, emits `gate_recorded` → JS displays the person/result overlay and status. Employees are logged but the Python SMS queue is student-only. **QR/manual:** browser resolves a student ID or employee, determines entry/exit with JS settings, writes `entry_exit_logs` directly and displays feedback; no SMS call is visible in these paths. The JS gate's late threshold affects QR/manual and older direct-write helpers, while Python's face insert sets `is_late=False`. Face-gate date and alternating logic therefore differ from QR/manual behavior.

## 15. SMS Architecture

The provider is **iPROG**, invoked only from backend `students/sms_notifications.py` using an HTTP JSON POST (`api_token`, normalized Philippine mobile, message, provider selector). `flask_attendance.py` reads `system_settings.sms_enabled` before a queued send, resolves a primary guardian through `student_guardians` → `guardians` (alternate phone fallback), builds one of four messages: school entered/exited or event attended/exited with name/time (and event name), and records token-free status in memory exposed by `/sms_status*`. Event time-in/out and student **face** gate entry/exit enqueue SMS after attendance/log persistence. A per-notification key suppresses repeats in process memory. Provider/config/phone failures are logged, but do not undo attendance. When the setting cannot be read, SMS is skipped; when no row exists, code defaults to enabled. `admin/system-settings.js` saves the switch. SMS delivery for QR/manual gate or manual event attendance is **NOT FOUND**. API credentials are intentionally omitted: [REDACTED]. The code and migration exist; live deployment/delivery are **UNKNOWN**.

## 16. Authentication and Session Management

`auth/login.js` uses Supabase Auth `signInWithPassword`, then checks `admins.admin_id` and active status. It puts a simplified profile in `sessionStorage.user`; `portal/portal.js` and `shared/global.js` inspect that object for display and navigation. Module sidebar scripts check it and use `allowed_admin_route` for navigation; `shared/logout-modal.js` signs out of Supabase and clears session storage. Reset flows call Supabase Auth. `auth/register.js` signs up a professor and stores an inactive profile, but the login function does not load professor profiles. `admin/delete-admin.php` is the clearest server-side permission check: verifies bearer identity against Supabase and the active super-admin row. **Visible architectural concerns:** client-side session/role checks are not a substitute for RLS/server authorization; full RLS and page/API protection cannot be confirmed. `auth/register.js` writes the supplied password into the `professors` profile payload, and its attempted `supabaseClient.auth.admin.deleteUser` from a browser is not a dependable privileged rollback. Do not copy any credential or password value into documentation.

## 17. Reports and Analytics

Event `attendanceReports.js` combines `lab_attendance` and `event_attendance`/`events`, with search/status/date/course/event filters, Chart.js summaries, XLSX and PDF export. `attendanceGraphs.js` draws subject/professor/semester charts from lab attendance/enrollment data and saves graph export metadata in `las_reports`. `eventAttendanceTrends.js` reads event history and aggregates participant/attendance trends. `reports.js` lists/filter saved `las_reports` export history. Gate `reports.js` reads `entry_exit_logs` for daily and weekly views (and other selectable groupings in that file), charts, CSV/PDF; `entry-exitLogs.js` lists logs. `dashboard.js` files calculate summary cards. Student pages read `daily_attendance` and may save `attendance_reports` metadata. These are client-generated reports, not evidence of a scheduled reporting service. Verify each report's source table before changing an export; similarly named report tables serve different pages.

## 18. Shared Components

Centralized across areas: `config/config.js` for browser Supabase client, `shared/global.js` for session/audit helpers, `shared/logout-modal.*` for logout, `config/supabase-server.php` for privileged PHP Supabase requests, and the Flask face engine for event and face-gate scanning. Event and gate admin submodules each have their own fetched header/sidebar pair, not one universal component. Page-specific toast/alert/dialog/date/filter helpers are duplicated. SMS generation and delivery are centralized in `sms_notifications.py`, but only Flask attendance calls them. Email helpers, QR generation and report exports are not uniformly centralized.

## 19. Module Dependencies

```text
                    auth/login + portal
                           |
          +----------------+----------------+
          |                |                |
     Super Admin      Event / Lab      School Gate
     admin/*          TimeInAnd...     EntryExit...
          |                |                |
          +--------- browser Supabase JS --+
                           |
                 Supabase Auth / Postgres / Storage
                           ^
               +-----------+-----------+
               |                       |
        face_capture.py :5001   flask_attendance.py :5000
        registration/storage    event or gate mode, SSE/MJPEG,
                               database writes, email + SMS jobs
               ^                       ^
               +------ camera ownership file ------+
```

Apache/PHP launches local BAT files and sends emails/privileged admin requests. Gate QR/manual and many admin actions bypass Flask and call Supabase directly. The face registration service triggers a rebuild in the attendance service after upload.

## 20. Important File Reference

| File | Purpose | Used by | Important functions/classes |
| --- | --- | --- | --- |
| `EVENTMONITORING/config/config.js` | Browser Supabase client | Most HTML pages | `supabaseClient`, `SUPABASE_CONFIG` |
| `EVENTMONITORING/shared/global.js` | Session/role and audit helpers | Admin/portal pages | `getCurrentUser`, `isSuperAdmin`, `logSystemAudit` |
| `EVENTMONITORING/auth/login.js` | Admin Auth/profile login | Login page | `loginUser`, password-reset handlers |
| `EVENTMONITORING/portal/portal.js` | Module access cards | Portal | role/card filtering, session checks |
| `EVENTMONITORING/admin/usermanagement.js` + `admin/delete-admin.php` | Admin CRUD/deletion | Super-admin UI | `deleteAdmin`, `handleDeleteAdminRequest` |
| `EVENTMONITORING/admin/student-import.js` | Student import/registration/guardians | Super-admin UI | import preview, validation, student CRUD |
| `EVENTMONITORING/admin/system-settings.js` | School year and SMS switch | Super-admin settings | `loadSmsSetting`, `saveSmsSetting`, `activateSchoolYear` |
| `EVENTMONITORING/TimeInAndTimeOutMonitoring/resc/js/events.js` | Event/participant CRUD/status | Event admin | `computeEventStatus`, `updateEventStatusesLocal`, `deleteEvent`, `eventForm` submit handler |
| `EVENTMONITORING/TimeInAndTimeOutMonitoring/resc/js/manualAttendance.js` | Manual event attendance | Manual attendance page | `confirmStudentEvent` |
| `EVENTMONITORING/TimeInAndTimeOutMonitoring/resc/js/takeAttendance.js` | Live face event UI | Attendance page | `handleRecognitionEvent`, `showGreeting` |
| `EVENTMONITORING/TimeInAndTimeOutMonitoring/students/face_capture.py` | Face registration Flask service | Registration UI | `start_reg`, `upload_to_supabase`, `generate_frames` |
| `EVENTMONITORING/TimeInAndTimeOutMonitoring/students/flask_attendance.py` | Shared recognition/event/gate Flask service | Event and gate scanners | `recognition_worker`, `_record_event_attendance`, `_record_gate_log` |
| `EVENTMONITORING/TimeInAndTimeOutMonitoring/students/sms_notifications.py` | Guardian SMS helper | Attendance Flask service | `resolve_guardian_phone`, `generate_attendance_sms`, `send_sms` |
| `EVENTMONITORING/EntryExitMonitoring/resc/js/entryExitScanner.js` | Face/QR/manual gate UI | Gate scanner | `startFaceMode`, `logEntryByStudId`, `determineLogType` |
| `EVENTMONITORING/EntryExitMonitoring/resc/js/reports.js` | Gate reports/export | Gate admin | `generateReport`, `exportCSV`, `exportPDF` |
| `EVENTMONITORING/database/migrations/20260924_system_settings_sms.sql` | SMS switch schema/RLS | Deployment/database | `system_settings` DDL and policies |

## 21. Known Issues / Technical Debt (observed, not changed)

- `MODULE_FLOW.md` documents `/start_attendance`, `/stop_attendance`, `/rebuild_cache`, an `attendance` table and a `facial_data` table; those routes/table uses are **not present in the current active Flask source**. The current implementation uses scanner mode, `/trigger_rebuild`, `event_attendance`, `entry_exit_logs`, Storage and profile embeddings. Treat that older document as historical, not API truth.
- `auth/login.js` currently admits only active `admins`, while portal code has student/professor/faculty/dean branches and `auth/register.js` creates professor profiles. The latter account flow is incomplete from the visible login path.
- `face_capture.py` saves `role=professor` face paths in `professors`, while the active attendance cache loader reads students and `employees` with `role=teacher`. A professor-only face registration is therefore not clearly included in recognition unless another path synchronizes the employee row; no such synchronization was confirmed.
- `auth/register.js` includes a plaintext `password` field in a `professors` insert payload and attempts an Auth admin deletion from browser JS. These are visible security/maintainability concerns; live policies are unknown.
- In face gate mode, Python `_record_gate_log` ignores `gate_settings.autoExit`, `cooldown`, and `lateThreshold`; its `is_late` is false. QR/manual JS uses those settings. The file still has direct face-write helper functions, but the active SSE `gate_recorded` branch only displays Flask's result.
- `flask_attendance.py` emits `type: "errfaor"` for an upcoming event, inconsistent with its normal `error` type. Event page default handling may still show a generic greeting, but special error styling is not guaranteed.
- Event status changes are computed/written from `events.js`; no scheduled server-side transition was found. Overlapping admins/scanners can observe stale statuses until an updater runs.
- Many pages repeat toast/alert/formatting code and dialog markup; some use native `alert/confirm`, others Bootstrap/custom overlays. Two modules have separate header/sidebar loaders. Long scripts (`admin/student-import.js`, `flask_attendance.py`, `entryExitScanner.js`) combine UI, data and workflow logic.
- No page with duplicate Bootstrap CSS or bundle imports was found by scanning HTML references; the duplication observed here is components/helpers, not confirmed repeated Bootstrap imports on one page. `config/config.js` creates the Supabase client separately in each document, which matches the multipage design; multiple competing client constructors on one inspected page were not confirmed.
- `STOP_ENGINE.bat` kills every `pythonw.exe`; launchers/PHP wrappers embed local Windows paths. Portable deployment is not established.
- `Gemma/main.py` also listens on localhost port 5000, so running it alongside the attendance service causes a port conflict. Its hard-coded FAQ prompt describes modules absent from this repository; use the source files, not that prompt, for architecture claims.
- `students/face_capture.py` defines `_ensure_xml_log` and `_audit_event` twice; later definitions replace earlier ones. `teachers` and `employees`, and `daily_attendance`, `event_attendance`, `lab_attendance`, `entry_exit_logs` coexist; their names should not be treated as interchangeable.
- Some client fetches and database operations occur sequentially per row/person (for example face-file existence checks and bulk import paths). Potential latency is observable from structure; actual performance was not measured.
- Full schema/migration history, foreign keys, RLS for most tables, deployment state, external service success and end-to-end tests are **UNKNOWN**. `tests/delete-admin.test.php` covers one PHP endpoint; a comprehensive test suite is **NOT FOUND**.

## 22. Current Architecture Summary

This is a multipage HTML/CSS/vanilla-JS XAMPP application with selected Bootstrap components, Supabase Auth/Postgres/Storage, small PHP endpoints, and two localhost Python/Flask/OpenCV services. Super-admin pages maintain users and reference data; the event/lab module manages participants, face registration, event time-in/out and lab attendance; the gate module records face/QR/manual entry/exit. A shared Flask attendance engine recognizes one face at a time using 128-D `face_recognition` encodings, Euclidean threshold `<0.40`, optional Silent-Face liveness, and SSE/MJPEG output. Event scans write `event_attendance`; face gate scans write `entry_exit_logs`; QR/manual gate uses browser Supabase writes. Guardian SMS for face/event scans is queued after persistence through backend iPROG helpers and controlled by `system_settings.sms_enabled`; event attendance also queues email. Current browser login authorizes active admin profiles; other role branches exist but are not established end-to-end.

## 23. Important Instructions for Future AI Assistance

When modifying this project:

- inspect the relevant files before making changes
- preserve existing functionality
- avoid rewriting unrelated code
- reuse existing shared utilities
- do not assume database schema
- do not expose secrets
- distinguish shared functionality from module-specific functionality
- preserve feature-specific Bootstrap modals
- avoid project-wide blind search-and-replace
- verify asynchronous behavior when replacing `confirm()` or `alert()`
- prefer incremental architectural improvements over full rewrites

Check current source before relying on `MODULE_FLOW.md` or other older documentation, and verify which attendance table and scanner mode the target page actually uses.
