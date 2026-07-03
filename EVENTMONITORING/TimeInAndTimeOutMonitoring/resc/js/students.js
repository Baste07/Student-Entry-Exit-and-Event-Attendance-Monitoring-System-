/* ============================================================
   resc/js/attendeesList.js
   Students List — Supabase migration
============================================================ */
// ── Get department logos from session ─────────────────────────
function getDeptLogos() {
    try {
        const user = JSON.parse(sessionStorage.getItem('user') || '{}');
        return {
            deptLogo: user.departmentLogo || '../resc/assets/ccs_logo.png',
            deptName: user.department     || 'College of Computer Studies',
            deptCode: user.departmentCode || 'CCS',
        };
    } catch (e) {
        return {
            deptLogo: '../resc/assets/ccs_logo.png',
            deptName: 'College of Computer Studies',
            deptCode: 'CCS',
        };
    }
}
// ── State ──────────────────────────────────────────────────
let allStudents  = [];
let reportRows   = [];
let META = { total: 0, registered: 0, pending: 0, date: '' };
const FACE_BUCKET = 'facial_data';

async function hasFaceFilesInStorage(datasetPath) {
    if (!datasetPath) return false;

    try {
        const { data, error } = await supabaseClient.storage
            .from(FACE_BUCKET)
            .list(datasetPath, {
                limit: 20,
                offset: 0,
                sortBy: { column: 'name', order: 'asc' }
            });

        if (error) return false;

        return (data || []).some(f => {
            const name = (f?.name || '').toLowerCase();
            return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
        });
    } catch {
        return false;
    }
}

function resolveHasFace(student) {
    if (student && typeof student.has_face_images === 'boolean') {
        return student.has_face_images;
    }
    return !!student?.facial_dataset_path;
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        showToast('⚠️ Supabase not configured. Check config/.env.js', false);
        return;
    }
    await loadStudents();
    initFilters();
    initAddStudentForm();
    initDuplicateChecks();
});

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const role      = params.get('role');       // "student" or "professor"
    const studentId = params.get('student_id'); // raw digits e.g. "2300223"

    // 1. Auto-select the Student tab if role=student
    if (role === 'student') {
        // Click the Student role button to activate it
        document.querySelectorAll('.role-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const studentBtn = document.querySelector('.role-btn[data-role="student"]');
        if (studentBtn) {
            studentBtn.classList.add('active');
            studentBtn.click(); // trigger any tab-switching logic already attached
        }
    }

    // 2. Pre-fill the Student ID field and auto-trigger the search
    if (studentId) {
        // Format for display: "2300223" → "23-00223"
        const formatted = studentId.replace(/^(\d{2})(\d+)$/, '$1-$2');

        // Try the most common ID field names — adjust if yours differs
        const idField = document.getElementById('studentId')
                     || document.getElementById('student_id')
                     || document.querySelector('input[name="student_id"]')
                     || document.querySelector('input[placeholder*="ID"]');

        if (idField) {
            idField.value = formatted;
            // Fire input/change so any listeners pick it up
            idField.dispatchEvent(new Event('input', { bubbles: true }));
            idField.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
});

// ══════════════════════════════════════════════════════════
// 1. LOAD STUDENTS FROM SUPABASE
// ══════════════════════════════════════════════════════════
async function loadStudents() {
    try {
        const { data: students, error } = await supabaseClient
            .from('students')
            .select(`
                student_id,
                id_number,
                first_name,
                middle_name,
                last_name,
                course,
                year_level,
                section,
                email,
                facial_dataset_path,
                status,
                created_at
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        allStudents = await Promise.all((students || []).map(async s => ({
            ...s,
            has_face_images: await hasFaceFilesInStorage(s.facial_dataset_path)
        })));
        // NEW: Populate dropdowns based on available data
        populateDynamicFilters();

        const total      = allStudents.length;
        const registered = allStudents.filter(s => resolveHasFace(s)).length;
        const pending    = total - registered;

        META = {
            total,
            registered,
            pending,
            date: new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        };

        document.getElementById('statTotal').textContent      = total;
        document.getElementById('statRegistered').textContent = registered;
        document.getElementById('statPending').textContent    = pending;

        renderTable(allStudents);
        await buildReportRows();

    } catch (err) {
        console.error('loadStudents error:', err);
        document.getElementById('studentsTableBody').innerHTML =
            `<tr><td colspan="10" style="text-align:center;padding:40px;color:#dc2626">
                <i class="fa-solid fa-circle-exclamation"></i> Failed to load students: ${err.message}
            </td></tr>`;
    }
}

// ══════════════════════════════════════════════════════════
// 2. RENDER TABLE
// ══════════════════════════════════════════════════════════
function renderTable(students) {
    const tbody = document.getElementById('studentsTableBody');

    if (!students.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:#9ca3af">
            <i class="fa-solid fa-users" style="font-size:32px;display:block;margin-bottom:10px;color:#dcfce7"></i>
            No students found.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = students.map(s => {
        const hasFace = resolveHasFace(s);
        const yearSec = `${s.year_level || ''}${s.section || ''}` || '-';
        const dateReg = s.created_at
            ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-';
        const statusCls = (s.status || 'active').toLowerCase();
        const faceData  = hasFace ? 'registered' : 'not-registered';
        const displayId = formatStudentId(s.id_number);

        return `<tr data-id="${s.student_id}" data-status="${statusCls}" data-face="${faceData}">
            <td style="font-weight:700;color:#166534">${escHtml(displayId)}</td>
            <td style="font-weight:600">${escHtml(s.last_name)}</td>
            <td>${escHtml(s.first_name)}</td>
            <td>${escHtml(s.middle_name || '-')}</td>
            <td>${escHtml(s.suffix || '-')}</td>
            <td>${escHtml(s.course || '-')}</td>
            <td>${escHtml(yearSec)}</td>
            <td style="font-size:12.5px">${escHtml(s.email || '-')}</td>
            <td>
                ${hasFace
                    ? `<span class="action-icon face-reg reg-done" title="Facial data registered"><i class="fas fa-check"></i></span>`
                    : `<span class="action-icon face-reg" title="Register facial data"
                         onclick="openFaceRegModal('${escHtml(s.id_number)}')">
                         <i class="fas fa-times"></i>
                       </span>`
                }
            </td>
            <td style="font-size:12.5px">${dateReg}</td>
        </tr>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// 3. FILTERS & SEARCH
// ══════════════════════════════════════════════════════════
function populateDynamicFilters() {
    const courseFilter = document.getElementById('courseFilter');
    const ysFilter = document.getElementById('yearSectionFilter');

    if (!courseFilter || !ysFilter) return;

    // Get unique courses, sort them alphabetically, and ignore empties
    const courses = [...new Set(allStudents.map(s => (s.course || '').toString().trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b));
    
    // Get unique Year & Section combos (e.g. "1A", "3B"), sort them, and ignore empties
    const yearSecs = [...new Set(allStudents.map(s => `${(s.year_level || '').toString().trim()}${(s.section || '').toString().trim()}`).filter(val => val.length > 0))].sort((a,b) => a.localeCompare(b));

    // Populate dropdowns while keeping the default "All" option
    courseFilter.innerHTML = '<option value="">All Programs</option>' + courses.map(c => `<option value="${c}">${c}</option>`).join('');
    ysFilter.innerHTML = '<option value="">All Yr & Sec</option>' + yearSecs.map(ys => `<option value="${ys}">${ys}</option>`).join('');
    // Ensure listeners are bound (safe if already bound) and apply current filters
    try { bindFilterListeners(); applyFilters(); } catch (_) {}
}

function initFilters() {
    const searchInput  = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');
    const faceFilter   = document.getElementById('faceFilter');
    const sortFilter   = document.getElementById('sortFilter');
    const courseFilter = document.getElementById('courseFilter');
    const ysFilter     = document.getElementById('yearSectionFilter');

    if (searchInput) {
        searchInput.addEventListener('input', applyFilters);
        searchInput.addEventListener('keyup', applyFilters);
    }

    // Use binder to safely attach listeners (idempotent)
    bindFilterListeners();

    window.applyStudentFilters = applyFilters;

    const clearBtn = document.getElementById('clearFilters');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            statusFilter.value = '';
            faceFilter.value = '';
            sortFilter.value = '';
            if (courseFilter) courseFilter.value = '';
            if (ysFilter) ysFilter.value = '';
            applyFilters();
        });
    }
}

function bindFilterListeners() {
    const els = ['statusFilter','faceFilter','sortFilter','courseFilter','yearSectionFilter'];
    els.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.dataset._filtersBound === '1') return;
        el.addEventListener('change', applyFilters);
        el.dataset._filtersBound = '1';
    });
}

function applyFilters() {
    const searchInput = document.getElementById('searchInput');
    const q   = (searchInput?.value || '').toLowerCase().trim();
    const st  = document.getElementById('statusFilter').value;
    const fc  = document.getElementById('faceFilter').value;
    const so  = document.getElementById('sortFilter').value;
    const crs = (document.getElementById('courseFilter')?.value || '').toString().trim().toLowerCase();
    const ys  = (document.getElementById('yearSectionFilter')?.value || '').toString().trim().toLowerCase();

    let filtered = allStudents.filter(s => {
        const formattedId = formatStudentId(s.id_number || '').toLowerCase();
        const fullName = `${s.first_name || ''} ${s.middle_name || ''} ${s.last_name || ''}`.toLowerCase();
        const searchable = `${formattedId} ${s.id_number || ''} ${fullName} ${s.course || ''} ${s.year_level || ''}${s.section || ''} ${s.email || ''}`.toLowerCase();
        
        // 1. Text Search
        const matchQ  = !q || searchable.includes(q);
                           
        // 2. Status & Face Check
        const matchSt = !st || (s.status || 'active').toLowerCase() === st;
        const hasFace = resolveHasFace(s);
        const matchFc = !fc || (fc === 'registered' ? hasFace : !hasFace);
        
        // 3. NEW: Program & Year/Section Check
        const courseVal = (s.course || '').toString().trim().toLowerCase();
        const matchCrs = !crs || courseVal === crs;
        const sYS = `${(s.year_level || '').toString().trim()}${(s.section || '').toString().trim()}`.toLowerCase();
        const matchYS = !ys || sYS === ys;

        return matchQ && matchSt && matchFc && matchCrs && matchYS;
    });

    if (so === 'az') filtered.sort((a, b) => a.last_name.localeCompare(b.last_name));
    if (so === 'za') filtered.sort((a, b) => b.last_name.localeCompare(a.last_name));

    renderTable(filtered);
}
// ══════════════════════════════════════════════════════════
// 4. ADD / EDIT STUDENT
// ══════════════════════════════════════════════════════════
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function initAddStudentForm() {
    const addStudentForm = document.getElementById('addStudentForm');
    if (!addStudentForm) return;

    const idInput = document.getElementById('field_id_number');
    if (idInput) {
        idInput.addEventListener('input', function () {
            const start = this.selectionStart;
            const prev  = this.value;
            this.value  = formatStudentId(this.value);
            const diff  = this.value.length - prev.length;
            this.setSelectionRange(start + diff, start + diff);
        });
    }

    const courseInput = document.querySelector('[name="course"]');
    if (courseInput) {
        courseInput.addEventListener('input', function () {
            const pos = this.selectionStart;
            this.value = this.value.toUpperCase();
            this.setSelectionRange(pos, pos);
        });
    }

    const sectionInput = document.querySelector('[name="section"]');
    if (sectionInput) {
        sectionInput.addEventListener('input', function () {
            this.value = this.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
        });
    }

    addStudentForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (document.querySelector('#addStudentModal .dup-msg.show')) {
            showToast('⚠️ Fix duplicate errors before saving.', false);
            return;
        }

        const btn = document.getElementById('addStudentBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        const fd = new FormData(this);
        const idNumberRaw = rawStudentId(fd.get('id_number')?.trim() || '');
        const firstName   = fd.get('first_name')?.trim() || '';
        const lastName    = fd.get('last_name')?.trim() || '';
        const email       = fd.get('email')?.trim() || '';
        const editId      = this.dataset.editId;

        if (!editId && !idNumberRaw) {
            showToast('❌ Student ID is required.', false);
            btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Student'; return;
        }
        if (!editId && !/^\d{7}$/.test(idNumberRaw)) {
            showToast('❌ Student ID must be in format 23-00221 (7 digits).', false);
            btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Student'; return;
        }
        if (!firstName) {
            showToast('❌ First name is required.', false);
            btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Student'; return;
        }
        if (!lastName) {
            showToast('❌ Last name is required.', false);
            btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Student'; return;
        }
        if (email && !/^[a-z]+_[a-z]+@plpasig\.edu\.ph$/i.test(email)) {
            showToast('❌ Invalid email format. Must be: lastname_firstname@plpasig.edu.ph', false);
            btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Student'; return;
        }

        try {
            if (editId) {
                const { error } = await supabaseClient
                    .from('students')
                    .update({
                        first_name:  firstName,
                        middle_name: fd.get('middle_name')?.trim() || null,
                        last_name:   lastName,
                        course:      fd.get('course')?.trim() || null,
                        section:     fd.get('section')?.trim() || null,
                        year_level:  fd.get('year_level') ? parseInt(fd.get('year_level')) : null,
                        email:       email || null,
                        status:      fd.get('status') || 'active',
                    })
                    .eq('student_id', editId);

                if (error) throw error;
                showToast('✅ Student updated successfully!', false);
                delete this.dataset.editId;

            } else {
                const payload = {
                    student_id:  generateUUID(),
                    id_number:   idNumberRaw,
                    first_name:  firstName,
                    middle_name: fd.get('middle_name')?.trim() || null,
                    last_name:   lastName,
                    course:      fd.get('course')?.trim() || null,
                    section:     fd.get('section')?.trim() || null,
                    year_level:  fd.get('year_level') ? parseInt(fd.get('year_level')) : null,
                    email:       email || null,
                    status:      fd.get('status') || 'active',
                    password:    'changeme123',
                };

                const { error } = await supabaseClient
                    .from('students')
                    .insert([payload])
                    .select()
                    .single();

                if (error) {
                    let msg = error.message || 'Unknown error';
                    if (msg.includes('id_number') && msg.includes('unique'))
                        msg = `Student ID "${formatStudentId(idNumberRaw)}" already exists.`;
                    else if (msg.includes('email') && msg.includes('unique'))
                        msg = `Email "${email}" is already registered.`;
                    throw new Error(msg);
                }
                showToast('✅ Student added successfully!', false);
            }

            if (document.getElementById('addStudentModal')) {
                closeModal('addStudentModal');
            }
            this.reset();
            clearAddStudentDups();
            await loadStudents();

        } catch (err) {
            console.error('save student error:', err);
            showToast('❌ Error: ' + err.message, false);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Student';
        }
    });
}

async function openEditModal(studentId) {
    const addStudentForm = document.getElementById('addStudentForm');
    if (!addStudentForm) return;

    const student = allStudents.find(s => s.student_id === studentId);
    if (!student) return;

    document.getElementById('field_id_number').value    = formatStudentId(student.id_number || '');
    document.getElementById('field_first_name').value   = student.first_name || '';
    document.querySelector('[name="middle_name"]').value = student.middle_name || '';
    document.getElementById('field_last_name').value    = student.last_name || '';
    document.querySelector('[name="course"]').value      = student.course || '';
    document.querySelector('[name="section"]').value     = student.section || '';
    document.querySelector('[name="year_level"]').value  = student.year_level || '';
    document.querySelector('[name="status"]').value      = student.status || 'active';
    document.getElementById('field_email').value         = student.email || '';

    addStudentForm.dataset.editId = studentId;

    document.querySelector('#addStudentModal .modal-header h2').innerHTML =
        '<i class="fa-solid fa-pen-to-square"></i> Edit Student';
    document.getElementById('addStudentBtn').innerHTML =
        '<i class="fa-solid fa-save"></i> Update Student';

    if (document.getElementById('addStudentModal')) {
        openModal('addStudentModal');
    }
}

// ══════════════════════════════════════════════════════════
// 5. REMOVE STUDENT
// ══════════════════════════════════════════════════════════
async function removeStudent(studentId) {
    if (!confirm('Remove this student? This cannot be undone.')) return;

    try {
        const { error } = await supabaseClient
            .from('students')
            .delete()
            .eq('student_id', studentId);

        if (error) throw error;

        showToast('Student removed successfully.', false);
        await loadStudents();

    } catch (err) {
        console.error('removeStudent error:', err);
        showToast('❌ Error: ' + err.message, false);
    }
}

// ══════════════════════════════════════════════════════════
// 6. DUPLICATE CHECKS
// ══════════════════════════════════════════════════════════
function initDuplicateChecks() {
    const idField    = document.getElementById('field_id_number');
    const firstField = document.getElementById('field_first_name');
    const lastField  = document.getElementById('field_last_name');
    const emailField = document.getElementById('field_email');

    if (idField) {
        idField.addEventListener('input', debounce(async () => {
            const val = rawStudentId(idField.value.trim());
            if (!val || val.length < 7) { setDupState(idField, 'dup_id_number', false, ''); return; }
            const { count } = await supabaseClient
                .from('students').select('student_id', { count: 'exact', head: true })
                .eq('id_number', val);
            setDupState(idField, 'dup_id_number', count > 0, 'Student ID already exists.');
        }, 450));
    }

    const nameCheck = debounce(async () => {
        const first = firstField?.value.trim();
        const last  = lastField?.value.trim();
        if (!first || !last) { setDupState(lastField, 'dup_full_name', false, ''); return; }
        const { count } = await supabaseClient
            .from('students').select('student_id', { count: 'exact', head: true })
            .ilike('first_name', first).ilike('last_name', last);
        setDupState(lastField, 'dup_full_name', count > 0, 'A student with this name already exists.');
    }, 500);

    if (firstField) firstField.addEventListener('input', nameCheck);
    if (lastField)  lastField.addEventListener('input',  nameCheck);

    if (emailField) {
        emailField.addEventListener('input', debounce(async () => {
            const val = emailField.value.trim();
            if (val && !/^[a-z]+_[a-z]+@plpasig\.edu\.ph$/i.test(val)) {
                setDupState(emailField, 'dup_email', true, 'Format must be: <strong>lastname_firstname@plpasig.edu.ph</strong>');
                return;
            }
            if (!val) { setDupState(emailField, 'dup_email', false, ''); return; }
            const { count } = await supabaseClient
                .from('students').select('student_id', { count: 'exact', head: true })
                .eq('email', val);
            setDupState(emailField, 'dup_email', count > 0, 'Email already in use.');
        }, 500));
    }

    const closeButtons = document.querySelectorAll('#addStudentModal .close-modal');
    closeButtons.forEach(btn => {
        btn.addEventListener('click', clearAddStudentDups);
    });
}

function setDupState(field, msgElId, isDup, msg) {
    const msgEl = document.getElementById(msgElId);
    if (!field || !msgEl) return;
    if (isDup) {
        field.classList.add('dup-error');
        field.classList.remove('dup-ok');
        msgEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${msg}`;
        msgEl.classList.add('show');
        msgEl.classList.remove('ok');
    } else {
        field.classList.remove('dup-error');
        msgEl.classList.remove('show', 'ok');
        msgEl.innerHTML = '';
    }
}

function clearAddStudentDups() {
    ['field_id_number', 'field_first_name', 'field_last_name', 'field_email'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('dup-error', 'dup-ok');
    });
    ['dup_id_number', 'dup_full_name', 'dup_email'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.classList.remove('show', 'ok'); el.innerHTML = ''; }
    });
}
// ══════════════════════════════════════════════════════════
// 7. FACE REGISTRATION SEARCH
// ══════════════════════════════════════════════════════════
async function searchStudent() {
    const studentId    = document.getElementById('studentIdSearch').value.trim();
    const searchBtn    = document.getElementById('searchBtn');
    const searchResult = document.getElementById('searchResult');

    if (!studentId) { showToast('Please enter a Student ID.', false); return; }

    searchBtn.disabled = true;
    searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

    try {
        // ✅ FIX: Format the ID to ENSURE it has the dash (e.g., 23-00223) to match Supabase
        const searchId = formatStudentId(studentId);

        const { data: s, error } = await supabaseClient
            .from('students')
            .select('id_number, first_name, middle_name, last_name, course, year_level, section, email, facial_dataset_path')
            .eq('id_number', searchId)
            .single();

        if (error || !s) {
            showToast('Student not found.', false);
            searchResult.classList.remove('active');
            return;
        }

        const hasFace = await hasFaceFilesInStorage(s.facial_dataset_path);
        document.getElementById('faceStatus').className = 'face-status ' + (hasFace ? 'registered' : 'not-registered');
        document.getElementById('faceStatus').innerHTML = hasFace
            ? '<i class="fa-solid fa-check-circle"></i> Facial data already registered'
            : '<i class="fa-solid fa-exclamation-circle"></i> Facial data not registered yet';

        const rb = document.getElementById('registerFaceBtn');
        rb.style.display = hasFace ? 'none' : 'block';
        rb.dataset.studentId = searchId; // Store the dashed ID for the redirect

        document.getElementById('studentInfo').innerHTML = `
            <div class="info-item"><label>Student ID</label><div class="value">${escHtml(searchId)}</div></div>
            <div class="info-item"><label>Full Name</label><div class="value">${escHtml(s.first_name)} ${escHtml(s.middle_name || '')} ${escHtml(s.last_name)}</div></div>
            <div class="info-item"><label>Course</label><div class="value">${escHtml(s.course || '-')}</div></div>
            <div class="info-item"><label>Year &amp; Section</label><div class="value">${s.year_level || ''}${escHtml(s.section || '')}</div></div>
            <div class="info-item"><label>Email</label><div class="value">${escHtml(s.email || '-')}</div></div>
        `;
        searchResult.classList.add('active');

    } catch (err) {
        showToast('Error: ' + err.message, false);
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = '<i class="fa-solid fa-search"></i> Search Student';
    }
}

function openFaceRegModal(idNumber) {
    openModal('faceRegModal');
    document.getElementById('studentIdSearch').value = formatStudentId(idNumber);
    searchStudent();
}

function redirectToFaceReg() {
    const sid = document.getElementById('registerFaceBtn').dataset.studentId;
    // ⚠️ Adjust path to match where accountRegistration.html actually lives
    window.top.location.href =
        '../../TimeInAndTimeOutMonitoring/students/accountRegistration.html'
        + '?role=student&student_id=' + encodeURIComponent(sid);
}
// ══════════════════════════════════════════════════════════
// 8a. DOWNLOAD EXCEL TEMPLATE
// ══════════════════════════════════════════════════════════
async function downloadExcelTemplate() {
    if (typeof XLSX === 'undefined') {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    }

    const wb = XLSX.utils.book_new();
    const headers = ['Student ID', 'First Name', 'Middle Name', 'Last Name',
                     'Course', 'Year Level', 'Section', 'Email'];
    const sampleData = [
        ['2300221', 'Juan',  'Dela',   'Cruz',   'Computer Science',       '3', 'A', 'cruz_juan@plpasig.edu.ph'],
        ['2300222', 'Maria', 'Santos', 'Garcia', 'Information Technology', '2', 'B', 'garcia_maria@plpasig.edu.ph'],
        ['2300223', 'Pedro', '',       'Reyes',  'Computer Engineering',   '1', 'A', 'reyes_pedro@plpasig.edu.ph'],
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
    ws['!cols'] = [
        { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 20 },
        { wch: 25 }, { wch: 12 }, { wch: 15 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Student Import Template');

    const instructions = [
        ['STUDENT IMPORT TEMPLATE - INSTRUCTIONS'],[''],
        ['Column Definitions:'],
        ['A - Student ID',   'Required', 'Unique 7-digit identifier (e.g., 2300221)'],
        ['B - First Name',   'Required', "Student's first name"],
        ['C - Middle Name',  'Optional', "Student's middle name"],
        ['D - Last Name',    'Required', "Student's last name"],
        ['E - Course',       'Optional', 'e.g., Computer Science, Information Technology'],
        ['F - Year Level',   'Optional', 'Number from 1-5'],
        ['G - Section',      'Optional', 'e.g., A, B (Just the letter without the year)'],
        ['H - Email',        'Optional', 'Must follow lastname_firstname@plpasig.edu.ph'],
        [''],['Important Notes:'],
        ['1. Do NOT delete the header row (row 1)'],
        ['2. Student ID must be unique and exactly 7 digits'],
        ['3. First Name and Last Name are required'],
        ['4. Year Level must be a number between 1-5'],
        ['5. Email must follow: lastname_firstname@plpasig.edu.ph'],
        ['6. Delete the sample data rows before importing your own data'],
        ['7. Duplicate Student IDs will update the existing record'],
    ];

    const wsInstructions = XLSX.utils.aoa_to_sheet(instructions);
    wsInstructions['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 55 }];
    XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

    XLSX.writeFile(wb, 'student_import_template.xlsx');
}

// ══════════════════════════════════════════════════════════
// 8b. IMPORT STUDENTS FROM EXCEL
// ══════════════════════════════════════════════════════════
async function handleImport() {
    const fileInput    = document.getElementById('excelFile');
    const importBtn    = document.getElementById('importBtn');
    const progressDiv  = document.getElementById('importProgress');
    const progressFill = document.getElementById('progressFill');
    const summaryDiv   = document.getElementById('importSummary');

    if (!fileInput.files[0]) { showToast('Please select an Excel file.', false); return; }

    if (typeof XLSX === 'undefined') {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    }

    progressDiv.style.display = 'block';
    importBtn.disabled = true;
    importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const wb   = XLSX.read(e.target.result, { type: 'array' });
            const ws   = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

            const dataRows = rows.slice(1).filter(r => String(r[0] || '').trim() !== '');
            let successCount = 0, errorCount = 0;
            const errors = [];

            for (let i = 0; i < dataRows.length; i++) {
                const r      = dataRows[i];
                const rowNum = i + 2;
                const pct    = Math.round(((i + 1) / dataRows.length) * 100);
                progressFill.style.width = pct + '%';
                progressFill.textContent = pct + '%';

                const idNumber   = rawStudentId(String(r[0] || '').trim());
                const firstName  = String(r[1] || '').trim();
                const middleName = String(r[2] || '').trim() || null;
                const lastName   = String(r[3] || '').trim();
                const course     = String(r[4] || '').trim() || null;
                const yearRaw    = r[5] !== '' ? parseInt(r[5]) : null;
                const section    = String(r[6] || '').trim() || null;
                const email      = String(r[7] || '').trim() || null;

                if (!idNumber || !firstName || !lastName) {
                    errors.push(`Row ${rowNum}: Missing required fields`);
                    errorCount++; continue;
                }
                if (yearRaw !== null && (isNaN(yearRaw) || yearRaw < 1 || yearRaw > 5)) {
                    errors.push(`Row ${rowNum}: Invalid year level`);
                    errorCount++; continue;
                }
                if (email && !/^[a-z]+_[a-z]+@plpasig\.edu\.ph$/i.test(email)) {
                    errors.push(`Row ${rowNum}: Invalid email "${email}"`);
                    errorCount++; continue;
                }

                const { data: existing } = await supabaseClient
                    .from('students').select('student_id').eq('id_number', idNumber).maybeSingle();

                let opError;
                if (existing) {
                    const { error } = await supabaseClient.from('students')
                        .update({ first_name: firstName, middle_name: middleName, last_name: lastName, course, year_level: yearRaw, section, email })
                        .eq('student_id', existing.student_id);
                    opError = error;
                } else {
                    const { error } = await supabaseClient.from('students')
                        .insert([{ student_id: generateUUID(), id_number: idNumber, first_name: firstName, middle_name: middleName, last_name: lastName, course, year_level: yearRaw, section, email, status: 'active', password: 'changeme123' }]);
                    opError = error;
                }

                if (opError) { errors.push(`Row ${rowNum}: ${opError.message}`); errorCount++; }
                else successCount++;
            }

            summaryDiv.innerHTML = `
                <div class="success"><i class="fa-solid fa-check-circle"></i> Import completed!</div>
                <p><strong>Processed:</strong> ${dataRows.length}</p>
                <p><strong>Imported / Updated:</strong> <span class="success">${successCount}</span></p>
                ${errorCount > 0 ? `<p><strong>Errors:</strong> <span class="error">${errorCount}</span></p>
                    <ul style="margin-top:6px;font-size:12px;color:#dc2626;max-height:120px;overflow-y:auto">
                        ${errors.map(err => `<li>${err}</li>`).join('')}
                    </ul>` : ''}
            `;

            if (successCount > 0) {
                setTimeout(async () => { closeModal('importModal'); await loadStudents(); }, 2500);
            }

        } catch (err) {
            summaryDiv.innerHTML = `<div class="error"><i class="fa-solid fa-exclamation-circle"></i> Parse error: ${err.message}</div>`;
        } finally {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Import Students';
        }
    };
    reader.readAsArrayBuffer(fileInput.files[0]);
}

function loadScript(src) {
    return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
    });
}

// ══════════════════════════════════════════════════════════
// 9. REPORT MODAL
// ══════════════════════════════════════════════════════════
async function buildReportRows() {
    const enriched = [];
    if (!Array.isArray(allStudents)) {
        console.warn('[students] buildReportRows: allStudents is not an array', allStudents);
        reportRows = [];
        return;
    }

    for (const s of allStudents) {
        try {
            let enrolled = 0;
            let attendances = 0;

            const enrollRes = await supabaseClient
                .from('schedule_enrollments')
                .select('enrollment_id', { count: 'exact', head: true })
                .eq('student_id', s.student_id)
                .eq('status', 'enrolled');

            if (enrollRes.error) {
                console.error('[students] schedule_enrollments error for', s.student_id, enrollRes.error);
            } else {
                enrolled = enrollRes.count || 0;
            }

            const attendRes = await supabaseClient
                .from('lab_attendance')
                .select('attendance_id', { count: 'exact', head: true })
                .eq('student_id', s.student_id);

            if (attendRes.error) {
                console.error('[students] lab_attendance error for', s.student_id, attendRes.error);
            } else {
                attendances = attendRes.count || 0;
            }

            const dateReg = s.created_at
                ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
                : '-';

            enriched.push({
                id_number:         formatStudentId(s.id_number),
                first_name:        s.first_name,
                middle_name:       s.middle_name || '—',
                last_name:         s.last_name,
                course:            s.course || '—',
                year_level:        s.year_level || '—',
                section:           s.section || '—',
                email:             s.email || '—',
                face_status:       resolveHasFace(s) ? 'Registered' : 'Not Registered',
                status:            s.status || 'active',
                enrolled_subjects: enrolled || 0,
                total_attendances: attendances || 0,
                date_registered:   dateReg,
            });
        } catch (e) {
            console.error('[students] buildReportRows iteration failed for', s.student_id, e);
        }
    }

    reportRows = enriched;
    console.debug('[students] buildReportRows completed, rows:', reportRows.length);
}

let existingReportsToday = [];

async function openReportModal() {
    const tbody = document.getElementById('rmTableBody');
    document.getElementById('rmGenDate').innerHTML =
        `Generated ${META.date} &nbsp;·&nbsp; <span id="rmTotal">${META.total}</span> students`;
    document.getElementById('rmChipTotal').textContent      = META.total;
    document.getElementById('rmChipRegistered').textContent = META.registered;
    document.getElementById('rmChipPending').textContent    = META.pending;

    document.getElementById('rmOverlay').classList.add('on');

    // ── Render students IMMEDIATELY from allStudents (no waiting) ──
    if (!allStudents.length) {
        tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:40px;color:#9ca3af">No data available.</td></tr>`;
        return;
    }

    tbody.innerHTML = allStudents.map((s, i) => {
        const hasFace   = resolveHasFace(s);
        const faceLabel = hasFace ? 'Registered' : 'Not Registered';
        const faceClass = hasFace ? 'registered' : 'not-registered';
        const status    = (s.status || 'active').toLowerCase();
        const displayId = formatStudentId(s.id_number);
        const yearSec   = `${s.year_level || '—'}`;
        const section   = `${s.section || '—'}`;
        const dateReg   = s.created_at
            ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-';

        return `<tr data-rowid="${escHtml(String(s.student_id))}">
            <td style="color:#9ca3af;font-size:11px">${i + 1}</td>
            <td style="font-weight:700;color:#166534;font-size:12px">${escHtml(displayId)}</td>
            <td style="font-weight:600">${escHtml(s.last_name)}</td>
            <td>${escHtml(s.first_name)}</td>
            <td style="color:#6b7280">${escHtml(s.middle_name || '—')}</td>
            <td style="font-size:12px">${escHtml(s.course || '—')}</td>
            <td style="text-align:center">${escHtml(String(yearSec))}</td>
            <td style="text-align:center">${escHtml(section)}</td>
            <td><span class="rm-badge ${faceClass}">${faceLabel}</span></td>
            <td><span class="rm-badge ${status}">${capitalize(status)}</span></td>
            <td style="text-align:center" class="cell-enrolled"><i class="fa-solid fa-spinner fa-spin" style="color:#9ca3af;font-size:10px"></i></td>
            <td style="text-align:center" class="cell-attend"><i class="fa-solid fa-spinner fa-spin" style="color:#9ca3af;font-size:10px"></i></td>
            <td style="font-size:11.5px;color:#6b7280">${escHtml(s.email || '—')}</td>
            <td style="font-size:11.5px;color:#6b7280;white-space:nowrap">${dateReg}</td>
        </tr>`;
    }).join('');

    // ── Load enrollment + attendance counts in background ──
    loadReportCounts();

    // ── Also rebuild reportRows for export (PDF/CSV/Excel) ──
    buildReportRows();

    // ── Check for duplicate reports today ──
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('las_reports').select('report_name, report_data')
            .eq('report_type', 'students').like('report_name', `%${dateStr}%`);
        existingReportsToday = data
            ? data.map(d => ({ name: d.report_name, dataString: typeof d.report_data === 'string' ? d.report_data : JSON.stringify(d.report_data) }))
            : [];
    } catch (e) {
        existingReportsToday = [];
    }
}

// ── Fetch counts per student and update cells live ──
async function loadReportCounts() {
    for (const s of allStudents) {
        const row = document.querySelector(`tr[data-rowid="${CSS.escape(String(s.student_id))}"]`);
        if (!row) continue;

        const enrollCell  = row.querySelector('.cell-enrolled');
        const attendCell  = row.querySelector('.cell-attend');

        try {
            const [enrollRes, attendRes] = await Promise.all([
                supabaseClient
                    .from('schedule_enrollments')
                    .select('enrollment_id', { count: 'exact', head: true })
                    .eq('student_id', s.student_id)
                    .eq('status', 'enrolled'),
                supabaseClient
                    .from('lab_attendance')
                    .select('attendance_id', { count: 'exact', head: true })
                    .eq('student_id', s.student_id)
            ]);

            if (enrollCell) enrollCell.innerHTML = `<strong>${enrollRes.count || 0}</strong>`;
            if (attendCell) attendCell.innerHTML = `<strong>${attendRes.count || 0}</strong>`;
        } catch (e) {
            if (enrollCell) enrollCell.textContent = '—';
            if (attendCell) attendCell.textContent = '—';
        }
    }
}
function closeReportModal() {
    document.getElementById('rmOverlay').classList.remove('on');
}

function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Students Report — ${dateStr} (${exportType})`;
    const currentDataString = JSON.stringify(reportRows);
    const isExactDuplicate = existingReportsToday.some(r => r.name === reportName && r.dataString === currentDataString);
    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }
    return true;
}

async function saveReport() {
    if (!checkDuplicateWarning('Manual Save')) return;
    const btn = document.querySelector('.rm-btn[onclick="saveReport()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }
    await autoSaveReport('Manual Save');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to Reports'; }
}

async function autoSaveReport(exportType) {
    const dateStr    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Students Report — ${dateStr} (${exportType})`;
    const payload = { report_type: 'students', report_name: reportName, filters: JSON.stringify({}), report_data: JSON.stringify(reportRows) };
    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;
        if (exportType === 'Manual Save') showToast('Report saved successfully!', true);
        else console.log(`[Auto-Save] ${exportType} report archived.`);
        existingReportsToday.push({ name: payload.report_name, dataString: payload.report_data });
    } catch (err) {
        console.error('Auto-save error:', err);
    }
}
async function printReport() {
    if (!checkDuplicateWarning('Print')) return;

    const { deptLogo, deptName } = getDeptLogos(); // ✅ before HTML string

    const now = new Date();
    const nowStr = `${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    const cols = ['#','Student ID','Last Name','First Name','Middle Name','Course','Year','Section','Face Status','Status','Subjects','Attendances','Email','Date Registered'];
    const rows = reportRows.map((r, i) => {
        let faceColor = r.face_status.toLowerCase() === 'registered' ? '#166534' : '#d97706';
        let statusColor = r.status.toLowerCase() === 'active' ? '#166534' : (r.status.toLowerCase() === 'inactive' ? '#dc2626' : '#2563eb');
        return `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i + 1}</td><td><strong>${r.id_number}</strong></td>
            <td><strong>${r.last_name}</strong></td><td>${r.first_name}</td><td>${r.middle_name}</td>
            <td>${r.course}</td><td style="text-align:center">${r.year_level}</td>
            <td style="text-align:center">${r.section}</td>
            <td><span style="color:${faceColor};font-weight:bold">${r.face_status.toUpperCase()}</span></td>
            <td><span style="color:${statusColor};font-weight:bold">${r.status.toUpperCase()}</span></td>
            <td style="text-align:center">${r.enrolled_subjects}</td>
            <td style="text-align:center">${r.total_attendances}</td>
            <td style="font-size:9px">${r.email}</td><td>${r.date_registered}</td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Students List Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111}
        .header-container{background-color:#ffffff;color:#000000;text-align:center;margin-bottom:20px;padding:20px 15px;border:2px solid #000000;border-radius:8px;}
        .logos-text-wrapper{display:flex;justify-content:center;align-items:center;gap:25px;margin-bottom:10px}
        .logo-img{height:50px;width:auto;object-fit:contain}
        .univ-title{font-size:18px;font-weight:bold;color:#000000;line-height:1.2}
        .college-title{font-size:11px;color:#444444;letter-spacing:1px;text-transform:uppercase}
        .report-title{font-size:16px;font-weight:bold;color:#000000;margin-top:12px;text-transform:uppercase;letter-spacing:1px}
        .report-meta{font-size:11px;color:#555555;margin-top:5px}
        table{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #000000 !important}
        th{background:#ffffff;color:#000000;padding:8px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;border:1px solid #000000 !important}
        td{padding:8px 10px;border:1px solid #000000 !important;font-size:11px;text-align:center}
        td:nth-child(2),td:nth-child(3),td:nth-child(4),td:nth-child(5){text-align:left}
        tr:nth-child(even){background:#f9fafb}
        .footer{margin-top:20px;text-align:center;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
        @media print{body{padding:0px}}
    </style></head><body>
    <div class="header-container">
        <div class="logos-text-wrapper">
            <img src="../resc/assets/plp_logo.png" class="logo-img" alt="PLP Logo">
            <div>
                <div class="univ-title">PAMANTASAN NG LUNGSOD NG PASIG</div>
                <div class="college-title">${deptName}</div>
            </div>
            <img src="${deptLogo}" class="logo-img" alt="Department Logo">
        </div>
        <div class="report-title">Students List Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;&middot;&nbsp; Total: ${META.total} &nbsp;&middot;&nbsp; Face Registered: ${META.registered} &nbsp;&middot;&nbsp; Pending: ${META.pending}</div>
    </div>
    <table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="footer">Laboratory Attendance System &nbsp;&middot;&nbsp; ${nowStr}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script></body></html>`);
    w.document.close();
    await autoSaveReport('Print');
}

async function downloadPDF() {
    if (!checkDuplicateWarning('PDF')) return;
    if (!window.jspdf) { showToast('PDF library not loaded yet. Please try again.', true); return; }
    try {
        const { deptLogo, deptName } = getDeptLogos(); // ✅ before anything else

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const now = new Date();
        const nowStr = `${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
        const pageW = doc.internal.pageSize.width;

        function loadImage(src) {
            return new Promise((resolve) => {
                const img = new Image(); img.crossOrigin = 'anonymous';
                img.onload = () => { try { const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); resolve(canvas.toDataURL('image/png')); } catch(e) { resolve(null); } };
                img.onerror = () => resolve(null); img.src = src;
            });
        }

        // ✅ Use deptLogo instead of hardcoded ccs_logo.png
        const [plpData, ccsData] = await Promise.all([
            loadImage('../resc/assets/plp_logo.png'),
            loadImage(deptLogo)
        ]);

        const centerX = pageW / 2, headerHeight = 45;
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.1);
        doc.rect(10, 5, pageW - 20, headerHeight, 'S');

        const logoSize = 18;
        if (plpData) doc.addImage(plpData, 'PNG', centerX - 85, 10, logoSize, logoSize);
        if (ccsData) doc.addImage(ccsData, 'PNG', centerX + 67, 10, logoSize, logoSize);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text('PAMANTASAN NG LUNGSOD NG PASIG', centerX, 18, { align: 'center' });
        doc.setFontSize(9); doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'normal');
        doc.text(deptName.toUpperCase(), centerX, 23, { align: 'center' }); // ✅ dynamic
        doc.setFontSize(14); doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold');
        doc.text('STUDENTS LIST REPORT', centerX, 33, { align: 'center' });
        doc.setFontSize(8); doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${nowStr}  ·  Total: ${META.total}  ·  Face Registered: ${META.registered}  ·  Pending: ${META.pending}`, centerX, 39, { align: 'center' });

        const head = [['#','Student ID','Last Name','First Name','M.I.','Course','Yr','Sec','Face','Status','Subj','Att','Email','Date']];
        const body = reportRows.map((r, i) => [i+1, r.id_number, r.last_name, r.first_name, r.middle_name.substring(0,2)+'.', r.course, r.year_level, r.section, r.face_status.toUpperCase(), r.status.toUpperCase(), r.enrolled_subjects, r.total_attendances, r.email, r.date_registered]);

        doc.autoTable({
            head, body,
            startY: headerHeight + 10,
            margin: { left: 10, right: 10 },
            theme: 'grid',
            headStyles: { fillColor: [255,255,255], fontSize: 6.5, fontStyle: 'bold', textColor: [0,0,0], lineColor: [0,0,0], lineWidth: 0.1, halign: 'center', valign: 'middle' },
            styles: { fontSize: 6.5, cellPadding: 2, valign: 'middle', lineColor: [0,0,0], lineWidth: 0.1, textColor: [0,0,0] },
            columnStyles: { 0:{cellWidth:7,halign:'center'}, 1:{cellWidth:18,halign:'center',fontStyle:'bold'}, 2:{cellWidth:20}, 3:{cellWidth:20}, 4:{cellWidth:10}, 5:{cellWidth:22}, 6:{cellWidth:8,halign:'center'}, 7:{cellWidth:8,halign:'center'}, 8:{cellWidth:18,halign:'center',fontStyle:'bold'}, 9:{cellWidth:15,halign:'center',fontStyle:'bold'}, 10:{cellWidth:10,halign:'center'}, 11:{cellWidth:10,halign:'center'}, 12:{cellWidth:'auto'}, 13:{cellWidth:18,halign:'center'} },
            didParseCell(d) {
                if (d.column.index === 8 && d.section === 'body') { const s=(d.cell.text[0]||'').toLowerCase(); if(s==='registered'){d.cell.styles.textColor=[22,101,52];} if(s==='not registered'){d.cell.styles.textColor=[217,119,6];} }
                if (d.column.index === 9 && d.section === 'body') { const s=(d.cell.text[0]||'').toLowerCase(); if(s==='active'){d.cell.styles.textColor=[22,101,52];} if(s==='inactive'){d.cell.styles.textColor=[220,38,38];} if(s==='graduated'){d.cell.styles.textColor=[37,99,235];} }
            }
        });

        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156,163,175); doc.text(`Laboratory Attendance System  ·  Page ${i} of ${pages}  ·  ${nowStr}`, pageW/2, doc.internal.pageSize.height-8, { align: 'center' }); }
        doc.save(`Students_Report_${now.toISOString().split('T')[0]}.pdf`);
        await autoSaveReport('PDF');
    } catch (err) {
        console.error('PDF generation error:', err);
        showToast('There was an error generating the PDF.', true);
    }
}

async function exportCSV() {
    if (!checkDuplicateWarning('CSV')) return;
    const cols = ['#','Student ID','Last Name','First Name','Middle Name','Course','Year Level','Section','Face Status','Status','Enrolled Subjects','Total Attendances','Email','Date Registered'];
    const lines = [cols.join(','), ...reportRows.map((r, i) => [i+1,`"${r.id_number}"`,`"${r.last_name}"`,`"${r.first_name}"`,`"${r.middle_name}"`,`"${r.course}"`,r.year_level,`"${r.section}"`,`"${r.face_status}"`,r.status,r.enrolled_subjects,r.total_attendances,`"${r.email}"`,`"${r.date_registered}"`].join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `Students_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    await autoSaveReport('CSV');
}

async function exportExcel() {
    if (!checkDuplicateWarning('Excel')) return;
    if (!window.XLSX) return exportCSV();
    const wb = XLSX.utils.book_new();
    const headers = ['#','Student ID','Last Name','First Name','Middle Name','Course','Year Level','Section','Face Status','Status','Enrolled Subjects','Total Attendances','Email','Date Registered'];
    const rows = reportRows.map((r, i) => [i+1, r.id_number, r.last_name, r.first_name, r.middle_name, r.course, r.year_level, r.section, r.face_status, r.status.toUpperCase(), r.enrolled_subjects, r.total_attendances, r.email, r.date_registered]);
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Students');
    XLSX.writeFile(wb, `Students_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    await autoSaveReport('Excel');
}

// ══════════════════════════════════════════════════════════
// 10. MODAL HELPERS
// ══════════════════════════════════════════════════════════
function openModal(id) {
    const m = document.getElementById(id);
    m.style.display = 'flex';
    setTimeout(() => m.classList.add('active'), 10);
}

function closeModal(id) {
    const m = document.getElementById(id);
    m.classList.remove('active');
    setTimeout(() => {
        m.style.display = 'none';
        if (id === 'importModal') {
            document.getElementById('excelFile').value = '';
            document.getElementById('importProgress').style.display = 'none';
            document.getElementById('importSummary').innerHTML = '';
        }
        if (id === 'faceRegModal') {
            document.getElementById('studentIdSearch').value = '';
            document.getElementById('searchResult').classList.remove('active');
        }
        if (id === 'addStudentModal') {
            document.querySelector('#addStudentModal .modal-header h2').innerHTML =
                '<i class="fa-solid fa-user-plus"></i> Add Student';
            document.getElementById('addStudentBtn').innerHTML =
                '<i class="fa-solid fa-save"></i> Save Student';
            delete document.getElementById('addStudentForm').dataset.editId;
            document.getElementById('addStudentForm').reset();
            clearAddStudentDups();
        }
    }, 200);
}

window.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeReportModal();
        ['addStudentModal', 'importModal', 'faceRegModal'].forEach(id => {
            const m = document.getElementById(id);
            if (m && m.classList.contains('active')) closeModal(id);
        });
    }
});

// ══════════════════════════════════════════════════════════
// 11. UTILITIES
// ══════════════════════════════════════════════════════════
function formatStudentId(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/\D/g, '').slice(0, 7);
    if (digits.length <= 2) return digits;
    return digits.slice(0, 2) + '-' + digits.slice(2);
}

function rawStudentId(formatted) {
    if (!formatted) return '';
    return String(formatted).replace(/-/g, '');
}

function showToast(msg, showLink) {
    const t = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 4000);
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function capitalize(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}