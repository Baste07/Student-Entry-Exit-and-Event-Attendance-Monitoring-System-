const QR_EMAIL_ENDPOINT = '../../admin/send-student-qr-email.php';
const FACE_BUCKET = 'facial_data';

let students = [];
let filteredStudents = [];
let selectedIds = new Set();
let sentCount = 0;
let bulkSendModal = null;
let bulkSendState = null;
let bulkSendQueue = [];
let bulkSendAbortController = null;
let bulkSendStopRequested = false;
let bulkSendCursor = 0;

const BULK_SEND_CONCURRENCY = 3;

document.addEventListener('DOMContentLoaded', async () => {
    bindUi();

    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        showToast('Supabase is not configured.', true);
        renderTable([]);
        return;
    }

    await loadStudents();
});

function bindUi() {
    document.getElementById('btnRefresh')?.addEventListener('click', () => loadStudents());
    document.getElementById('btnSendSelected')?.addEventListener('click', () => sendSelectedStudents());
    document.getElementById('btnSelectVisible')?.addEventListener('click', () => selectVisibleStudents());
    document.getElementById('btnClearSelection')?.addEventListener('click', () => {
        selectedIds.clear();
        
        syncSelectionUi();
        renderTable(filteredStudents);
    });
    document.getElementById('btnClearFilters')?.addEventListener('click', clearFilters);
    document.getElementById('selectAllVisible')?.addEventListener('change', handleSelectAllVisible);

    ['searchInput', 'statusFilter', 'faceFilter', 'courseFilter', 'yearFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener(id === 'searchInput' ? 'input' : 'change', applyFilters);
    });

    document.getElementById('studentsTableBody')?.addEventListener('click', handleTableClick);

    bulkSendModal = document.getElementById('bulkSendModal');
    document.getElementById('btnCloseBulkModal')?.addEventListener('click', closeBulkSendModal);
    document.getElementById('btnRetryFailed')?.addEventListener('click', retryFailedStudents);
    document.getElementById('btnStopSending')?.addEventListener('click', stopSendingQrCodes);
    document.getElementById('btnShowBulkModal')?.addEventListener('click', reopenBulkSendModal);
    document.getElementById('bulkSendModal')?.addEventListener('click', event => {
        if (event.target === bulkSendModal) closeBulkSendModal();
    });
}

async function loadStudents() {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading students...</td></tr>';

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select('student_id, id_number, first_name, middle_name, last_name, course, year_level, section, email, status, facial_dataset_path, created_at')
            .order('last_name', { ascending: true });

        if (error) throw error;

        students = (data || []).map(student => ({
            ...student,
            full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
            face_registered: !!student.facial_dataset_path,
        }));

        populateFilters();
        applyFilters();
        updateStats();
    } catch (err) {
        console.error(err);
        tbody.innerHTML = `<tr><td colspan="9" class="empty-state error"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load students: ${escapeHtml(err.message || err)}</td></tr>`;
        showToast('Failed to load students.', true);
    }
}

function populateFilters() {
    const courseFilter = document.getElementById('courseFilter');
    const yearFilter = document.getElementById('yearFilter');
    if (!courseFilter || !yearFilter) return;

    const currentCourse = courseFilter.value;
    const currentYear = yearFilter.value;

    const courses = [...new Set(students.map(s => String(s.course || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const years = [...new Set(students.map(s => `${String(s.year_level || '').trim()}${String(s.section || '').trim()}`.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    courseFilter.innerHTML = '<option value="">All Courses</option>' + courses.map(course => `<option value="${escapeAttr(course)}">${escapeHtml(course)}</option>`).join('');
    yearFilter.innerHTML = '<option value="">All Yr & Sec</option>' + years.map(year => `<option value="${escapeAttr(year)}">${escapeHtml(year)}</option>`).join('');

    courseFilter.value = currentCourse;
    yearFilter.value = currentYear;
}

function applyFilters() {
    const search = String(document.getElementById('searchInput')?.value || '').trim().toLowerCase();
    const status = String(document.getElementById('statusFilter')?.value || '').trim().toLowerCase();
    const face = String(document.getElementById('faceFilter')?.value || '').trim().toLowerCase();
    const course = String(document.getElementById('courseFilter')?.value || '').trim().toLowerCase();
    const year = String(document.getElementById('yearFilter')?.value || '').trim().toLowerCase();

    filteredStudents = students.filter(student => {
        const id = formatStudentId(student.id_number).toLowerCase();
        const name = student.full_name.toLowerCase();
        const searchable = [id, student.id_number, name, student.course, student.year_level, student.section, student.email].join(' ').toLowerCase();
        const studentYear = `${String(student.year_level || '').trim()}${String(student.section || '').trim()}`.toLowerCase();

        const matchesSearch = !search || searchable.includes(search);
        const matchesStatus = !status || String(student.status || 'active').toLowerCase() === status;
        const matchesFace = !face || (face === 'registered' ? student.face_registered : !student.face_registered);
        const matchesCourse = !course || String(student.course || '').trim().toLowerCase() === course;
        const matchesYear = !year || studentYear === year;

        return matchesSearch && matchesStatus && matchesFace && matchesCourse && matchesYear;
    });

    renderTable(filteredStudents);
    updateStats();
}

function renderTable(rows) {
    const tbody = document.getElementById('studentsTableBody');
    const tableCount = document.getElementById('tableCount');
    if (!tbody) return;

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-users-slash"></i> No students match the current filters.</td></tr>';
        if (tableCount) tableCount.textContent = '0 shown';
        syncSelectionUi();
        return;
    }

    if (tableCount) tableCount.textContent = `${rows.length} shown`;

    tbody.innerHTML = rows.map(student => {
        const studentId = String(student.student_id || '');
        const checked = selectedIds.has(studentId) ? 'checked' : '';
        const faceLabel = student.face_registered ? 'Registered' : 'Not Registered';
        const faceClass = student.face_registered ? 'ok' : 'warn';
        const status = String(student.status || 'active').toLowerCase();
        const displayId = formatStudentId(student.id_number);
        const yearSec = `${student.year_level || '-'}${student.section || ''}` || '-';

        return `
            <tr data-id="${escapeAttr(studentId)}">
                <td><input type="checkbox" class="row-check" data-id="${escapeAttr(studentId)}" ${checked} aria-label="Select ${escapeAttr(displayId)}"></td>
                <td class="strong">${escapeHtml(displayId)}</td>
                <td>${escapeHtml(student.full_name || '-')}</td>
                <td>${escapeHtml(student.course || '-')}</td>
                <td>${escapeHtml(yearSec)}</td>
                <td>${escapeHtml(student.email || '-')}</td>
                <td><span class="badge ${faceClass}">${faceLabel}</span></td>
                <td><span class="badge status">${escapeHtml(capitalize(status))}</span></td>
                <td>
                    <button class="btn-send-row" data-action="send-one" data-id="${escapeAttr(studentId)}">
                        <i class="fa-solid fa-paper-plane"></i> Send QR
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    syncSelectionUi();
}

function handleTableClick(event) {
    const button = event.target.closest('[data-action="send-one"]');
    if (!button) return;

    const studentId = button.dataset.id;
    const student = students.find(item => String(item.student_id) === String(studentId));
    if (!student) return;

    sendOneStudent(student, button);
}

function handleSelectAllVisible() {
    const selectAll = document.getElementById('selectAllVisible');
    if (!selectAll) return;

    filteredStudents.forEach(student => {
        if (selectAll.checked) selectedIds.add(String(student.student_id));
        else selectedIds.delete(String(student.student_id));
    });

    renderTable(filteredStudents);
}

function selectVisibleStudents() {
    filteredStudents.forEach(student => selectedIds.add(String(student.student_id)));
    renderTable(filteredStudents);
}

function clearFilters() {
    document.getElementById('searchInput').value = '';
    document.getElementById('statusFilter').value = '';
    document.getElementById('faceFilter').value = '';
    document.getElementById('courseFilter').value = '';
    document.getElementById('yearFilter').value = '';
    applyFilters();
}

function syncSelectionUi() {
    const selectedCount = selectedIds.size;
    const visibleCount = filteredStudents.length;
    const visibleSelected = filteredStudents.filter(student => selectedIds.has(String(student.student_id))).length;
    const selectAll = document.getElementById('selectAllVisible');
    const sendBtn = document.getElementById('btnSendSelected');

    document.getElementById('statSelected').textContent = selectedCount;
    if (sendBtn) sendBtn.disabled = selectedCount === 0;

    if (selectAll) {
        selectAll.checked = visibleCount > 0 && visibleSelected === visibleCount;
        selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleCount;
    }
}

function updateStats() {
    document.getElementById('statTotal').textContent = students.length;
    document.getElementById('statSelected').textContent = selectedIds.size;
    document.getElementById('statSent').textContent = sentCount;
    const sendBtn = document.getElementById('btnSendSelected');
    if (sendBtn) sendBtn.disabled = selectedIds.size === 0;
}

async function sendSelectedStudents() {
    const targets = students.filter(student => selectedIds.has(String(student.student_id)));
    if (!targets.length) {
        showToast('Select at least one student first.', true);
        return;
    }

    const confirmed = confirm(`Send QR codes to ${targets.length} student(s)?`);
    if (!confirmed) return;

    openBulkSendModal(targets);
    await sendStudentsInBatches(targets);
}

async function sendOneStudent(student, buttonEl = null) {
    const confirmed = confirm(`Send a QR code to ${student.full_name || formatStudentId(student.id_number)}?`);
    if (!confirmed) return;

    if (buttonEl) setButtonLoading(buttonEl, true, 'Sending...');
    const result = await sendQrEmail(student);
    if (buttonEl) setButtonLoading(buttonEl, false, 'Send QR');

    if (result.sent) {
        sentCount += 1;
        document.getElementById('statSent').textContent = sentCount;
        showToast(`QR sent to ${student.full_name || formatStudentId(student.id_number)}.`, false);
    } else {
        showToast(`Failed to send ${student.full_name || formatStudentId(student.id_number)}: ${result.message}`, true);
    }
}

async function sendStudentsInBatches(targets) {
    const sendBtn = document.getElementById('btnSendSelected');
    if (sendBtn) setButtonLoading(sendBtn, true, `Sending ${targets.length}...`);

    bulkSendStopRequested = false;
    bulkSendAbortController = new AbortController();
    bulkSendCursor = 0;
    bulkSendQueue = targets.map(student => ({
        ...student,
        bulkStatus: 'pending',
        bulkMessage: '',
    }));
    bulkSendState = {
        total: targets.length,
        completed: 0,
        success: 0,
        failed: 0,
        failedIds: [],
        stopped: false,
    };
    renderBulkSendModal(bulkSendQueue, bulkSendState);
    await nextPaint();

    const workerCount = Math.min(BULK_SEND_CONCURRENCY, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => processBulkSendWorker()));

    if (sendBtn) setButtonLoading(sendBtn, false, 'Send Selected');
    finishBulkSendModal(bulkSendState?.success || 0, bulkSendState?.failed || 0, bulkSendStopRequested);
    showToast(
        bulkSendStopRequested
            ? `Sending stopped. ${bulkSendState?.success || 0} sent, ${bulkSendState?.failed || 0} failed.`
            : `Finished sending QR codes. ${bulkSendState?.success || 0} sent, ${bulkSendState?.failed || 0} failed.`,
        (bulkSendState?.failed || 0) > 0
    );
}

async function processBulkSendWorker() {
    while (!bulkSendStopRequested) {
        const currentIndex = bulkSendCursor++;
        const student = bulkSendQueue[currentIndex];
        if (!student) break;
        if (student.bulkStatus !== 'pending') continue;

        updateBulkCurrentRow(student);
        await nextPaint();

        const result = await sendQrEmail(student, bulkSendAbortController?.signal);
        if (result.stopped) {
            bulkSendStopRequested = true;
            if (bulkSendState) bulkSendState.stopped = true;
            break;
        }

        bulkSendState.completed += 1;

        if (result.sent) {
            bulkSendState.success += 1;
            sentCount += 1;
            student.bulkStatus = 'success';
            selectedIds.delete(String(student.student_id));
            removeBulkSendRow(student.student_id);
            syncSelectionUi();
            updateStats();
        } else {
            bulkSendState.failed += 1;
            student.bulkStatus = 'failed';
            student.bulkMessage = result.message || 'failed';
            if (bulkSendState && !bulkSendState.failedIds.includes(String(student.student_id))) {
                bulkSendState.failedIds.push(String(student.student_id));
            }
            console.warn(`QR send failed for ${student.id_number}:`, result.message);
            markBulkSendProgress('failed', student, result.message);
        }

        document.getElementById('statSent').textContent = sentCount;
        updateBulkSendSummary();
        scrollBulkSendToNextPending();
        await nextPaint();
    }
}

async function sendQrEmail(student, signal = null) {
    const payload = {
        email: String(student.email || '').trim(),
        studentId: String(student.id_number || '').trim(),
        firstName: String(student.first_name || '').trim(),
        middleName: String(student.middle_name || '').trim(),
        lastName: String(student.last_name || '').trim(),
        course: String(student.course || '').trim(),
        yearLevel: String(student.year_level ?? '').trim(),
        section: String(student.section || '').trim(),
        qrPayload: buildQrPayload(student),
    };

    if (!payload.email) {
        return { sent: false, message: 'missing student email' };
    }

    if (!payload.studentId) {
        return { sent: false, message: 'missing student ID' };
    }

    try {
        const response = await fetch(QR_EMAIL_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        });

        let result = null;
        try {
            result = await response.json();
        } catch (_) {
            result = null;
        }

        if (!response.ok || !result?.success) {
            const detail = result?.diagnostic ? ` ${result.diagnostic}` : '';
            return { sent: false, message: `${result?.message || `HTTP ${response.status}`}${detail}`.trim() };
        }

        return { sent: true, message: result.message || 'sent' };
    } catch (err) {
        if (err?.name === 'AbortError') {
            return { sent: false, stopped: true, message: 'Sending stopped.' };
        }
        return { sent: false, message: err.message || 'network error' };
    }
}

function buildQrPayload(student) {
    const fullName = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const course = String(student.course || '').trim() || 'N/A';
    const yearLevel = String(student.year_level ?? '').trim() || 'N/A';
    const section = String(student.section || '').trim() || 'N/A';

    return [
        'PLP Laboratory Attendance QR',
        `Name: ${fullName || 'N/A'}`,
        `Student ID: ${student.id_number}`,
        `Course: ${course}`,
        `Year: ${yearLevel}`,
        `Section: ${section}`,
    ].join('\n');
}

function setButtonLoading(button, loading, label) {
    if (!button) return;
    button.disabled = loading;
    button.innerHTML = loading
        ? '<i class="fa-solid fa-spinner fa-spin"></i> ' + escapeHtml(label)
        : '<i class="fa-solid fa-paper-plane"></i> ' + escapeHtml(label);
}

function openBulkSendModal(targets) {
    const modal = document.getElementById('bulkSendModal');
    if (!modal) return;

    modal.classList.add('on');
    document.body.classList.add('modal-open');
    hideBulkModalLauncher();

    const queue = Array.isArray(targets) && targets.length
        ? targets
        : bulkSendQueue.filter(item => item.bulkStatus !== 'success');
    renderBulkSendModal(queue, bulkSendState || {
        total: queue.length,
        completed: 0,
        success: 0,
        failed: 0,
        failedIds: [],
        stopped: false,
    });
}

function reopenBulkSendModal() {
    if (!bulkSendQueue.length) {
        showToast('No sending queue to reopen.', true);
        hideBulkModalLauncher();
        return;
    }

    openBulkSendModal();
}

function closeBulkSendModal() {
    const modal = document.getElementById('bulkSendModal');
    if (!modal) return;
    modal.classList.remove('on');
    document.body.classList.remove('modal-open');
    updateBulkModalLauncher();
}

function hideBulkModalLauncher() {
    const launcher = document.getElementById('btnShowBulkModal');
    if (launcher) launcher.style.display = 'none';
}

function updateBulkModalLauncher() {
    const launcher = document.getElementById('btnShowBulkModal');
    if (!launcher) return;

    const modal = document.getElementById('bulkSendModal');
    const isOpen = modal?.classList.contains('on');
    const hasQueue = bulkSendQueue.length > 0;
    const canReopen = hasQueue && !isOpen;
    launcher.style.display = canReopen ? 'inline-flex' : 'none';
}

function renderBulkSendModal(targets, state) {
    const modal = document.getElementById('bulkSendModal');
    const body = document.getElementById('bulkSendBody');
    if (!modal || !body) return;

    const rows = targets.map(student => `
        <tr data-student-id="${escapeAttr(student.student_id)}" data-bulk-status="pending">
            <td class="strong">${escapeHtml(formatStudentId(student.id_number))}</td>
            <td>${escapeHtml(student.full_name || '-')}</td>
            <td>${escapeHtml(student.email || '-')}</td>
            <td><span class="bulk-status pending">Pending</span></td>
        </tr>
    `).join('');

    body.innerHTML = rows || '<tr><td colspan="4" class="empty-state">No selected students.</td></tr>';
    updateBulkSendSummary(state);
    updateBulkSendProgress(state);
    syncRetryButton(state);
    syncStopButton(state);
    updateBulkModalLauncher();
}

function updateBulkCurrentRow(student) {
    const row = document.querySelector(`#bulkSendBody tr[data-student-id="${cssEscape(String(student?.student_id ?? ''))}"]`);
    if (!row) return;

    const title = document.getElementById('bulkSendTitle');
    if (title && bulkSendState?.total) {
        title.textContent = `Sending QR codes (${bulkSendState.completed + 1}/${bulkSendState.total})`;
    }

    const statusCell = row.querySelector('.bulk-status');
    if (statusCell && row.dataset.bulkStatus === 'pending') {
        statusCell.textContent = 'Sending...';
        statusCell.className = 'bulk-status pending';
    }
}

function updateBulkSendSummary(state = bulkSendState) {
    const total = state?.total ?? 0;
    const completed = state?.completed ?? 0;
    const success = state?.success ?? 0;
    const failed = state?.failed ?? 0;

    const elTotal = document.getElementById('bulkTotal');
    const elDone = document.getElementById('bulkDone');
    const elFailed = document.getElementById('bulkFailed');
    if (elTotal) elTotal.textContent = total;
    if (elDone) elDone.textContent = completed;
    if (elFailed) elFailed.textContent = failed;

    updateBulkSendProgress(state);
    const title = document.getElementById('bulkSendTitle');
    if (title) {
        if (state?.stopped) {
            title.textContent = 'Sending stopped';
        } else {
            title.textContent = total ? `Sending QR codes (${completed}/${total})` : 'Sending QR codes';
        }
    }
    syncRetryButton(state);
    syncStopButton(state);
}

function updateBulkSendProgress(state = bulkSendState) {
    const total = state?.total ?? 0;
    const completed = state?.completed ?? 0;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const bar = document.getElementById('bulkProgressBar');
    const label = document.getElementById('bulkProgressLabel');
    if (bar) bar.style.width = `${percent}%`;
    if (label) label.textContent = total ? `${percent}% complete` : '0% complete';
}

function markBulkSendProgress(status, student, message = '') {
    const row = document.querySelector(`#bulkSendBody tr[data-student-id="${cssEscape(String(student?.student_id ?? ''))}"]`);
    if (!row) return;
    row.dataset.bulkStatus = status;
    row.dataset.bulkMessage = message || '';

    const statusCell = row.querySelector('.bulk-status');
    if (statusCell) {
        if (status === 'success') {
            statusCell.textContent = 'Sent';
            statusCell.className = 'bulk-status success';
        } else if (status === 'failed') {
            statusCell.textContent = message ? `Failed: ${message}` : 'Failed';
            statusCell.className = 'bulk-status failed';
        }
    }
}

function removeBulkSendRow(studentId) {
    const row = document.querySelector(`#bulkSendBody tr[data-student-id="${cssEscape(String(studentId))}"]`);
    if (row) row.remove();
}

function removeBulkSendEntry(studentId) {
    bulkSendQueue = bulkSendQueue.filter(item => String(item.student_id) !== String(studentId));
}

function scrollBulkSendToNextPending() {
    const modal = document.getElementById('bulkSendModal');
    const pendingRow = document.querySelector('#bulkSendBody tr[data-bulk-status="pending"]');
    if (!modal || !pendingRow) return;

    const scrollContainer = modal.querySelector('.bulk-modal__table-wrap');
    pendingRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (scrollContainer) {
        scrollContainer.scrollTop = pendingRow.offsetTop - scrollContainer.offsetTop - 20;
    }
}

function syncRetryButton(state = bulkSendState) {
    const retryBtn = document.getElementById('btnRetryFailed');
    if (!retryBtn) return;

    const failed = state?.failed ?? 0;
    const completed = state?.completed ?? 0;
    const total = state?.total ?? 0;
    const shouldShow = failed > 0 && completed >= total;
    retryBtn.style.display = shouldShow ? 'inline-flex' : 'none';
    retryBtn.disabled = false;
}

function syncStopButton(state = bulkSendState) {
    const stopBtn = document.getElementById('btnStopSending');
    if (!stopBtn) return;

    const isActive = !!state && !state.stopped && state.completed < state.total;
    stopBtn.style.display = isActive ? 'inline-flex' : 'none';
    stopBtn.disabled = bulkSendStopRequested;
    stopBtn.innerHTML = bulkSendStopRequested
        ? '<i class="fa-solid fa-spinner fa-spin"></i> Stopping...'
        : '<i class="fa-solid fa-ban"></i> Stop Sending QR Code';
}

function stopSendingQrCodes() {
    if (!bulkSendState || bulkSendState.stopped) return;

    bulkSendStopRequested = true;
    bulkSendState.stopped = true;
    if (bulkSendAbortController) {
        bulkSendAbortController.abort();
    }

    const status = document.getElementById('bulkFinalStatus');
    if (status) {
        status.textContent = 'Stopping current send...';
    }
    syncStopButton();
    updateBulkModalLauncher();
}

async function retryFailedStudents() {
    if (!bulkSendState?.failedIds?.length) {
        showToast('No failed students to retry.', true);
        return;
    }

    const failedTargets = bulkSendState.failedIds
        .map(id => students.find(student => String(student.student_id) === String(id)))
        .filter(Boolean);

    if (!failedTargets.length) {
        showToast('No failed students to retry.', true);
        return;
    }

    const retryBtn = document.getElementById('btnRetryFailed');
    if (retryBtn) setButtonLoading(retryBtn, true, 'Retrying...');

    bulkSendState.total = failedTargets.length;
    bulkSendState.completed = 0;
    bulkSendState.success = 0;
    bulkSendState.failed = 0;
    bulkSendState.failedIds = [];
    renderBulkSendModal(failedTargets, bulkSendState);

    await sendStudentsInBatches(failedTargets);

    if (retryBtn) setButtonLoading(retryBtn, false, 'Retry Failed Only');
}

function finishBulkSendModal(success, failed, stopped = false) {
    updateBulkSendSummary();
    const status = document.getElementById('bulkFinalStatus');
    if (status) {
        status.textContent = stopped
            ? `Stopped: ${success} sent${failed ? `, ${failed} failed` : ''}.`
            : `Done: ${success} sent${failed ? `, ${failed} failed` : ''}.`;
    }

    if (!stopped && failed === 0) {
        setTimeout(() => {
            closeBulkSendModal();
            if (bulkSendState) {
                bulkSendState = null;
            }
            bulkSendQueue = [];
            updateBulkModalLauncher();
            applyFilters();
        }, 700);
    } else {
        syncRetryButton();
        syncStopButton();
        updateBulkModalLauncher();
    }
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function formatStudentId(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/\D/g, '').slice(0, 7);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

function capitalize(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (!toast || !toastMsg) {
        alert(message);
        return;
    }

    toastMsg.textContent = message;
    toast.className = `toast on ${isError ? 'error' : 'success'}`;
    setTimeout(() => toast.classList.remove('on'), 3500);
}

function handleRowSelectionChange(event) {
    const checkbox = event.target.closest('.row-check');
    if (!checkbox) return;

    const studentId = checkbox.dataset.id;
    if (checkbox.checked) selectedIds.add(studentId);
    else selectedIds.delete(studentId);

    syncSelectionUi();
    updateStats();
}

document.addEventListener('change', handleRowSelectionChange);
