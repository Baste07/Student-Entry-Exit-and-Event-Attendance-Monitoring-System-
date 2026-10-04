let allSchoolYears = [];
let savedSmsEnabled = true;
let savedAntiSpoofEnabled = true;
let savedAdminInactivityMinutes = 3;
let creatingSchoolYear = false;
let currentRolloverPreview = null;
const qrReissueCursorByYear = {};

document.addEventListener('DOMContentLoaded', async () => {
    checkSupabaseConnection();
    setupEventListeners();
    await Promise.all([loadSchoolYears(), loadSmsSetting()]);
    await loadRolloverControls();
});

function setupEventListeners() {
    document.getElementById('createSchoolYearBtn')?.addEventListener('click', createSchoolYear);
    document.getElementById('setActiveSchoolYearBtn')?.addEventListener('click', handleSetActiveClick);
    document.getElementById('inactivateSchoolYearBtn')?.addEventListener('click', handleInactivateClick);
    document.getElementById('existingSchoolYearSelect')?.addEventListener('change', handleSelectChange);
    document.getElementById('attendanceSmsToggle')?.addEventListener('change', event => saveCapability(event, 'sms_enabled'));
    document.getElementById('antiSpoofToggle')?.addEventListener('change', event => saveCapability(event, 'anti_spoof_enabled'));
    document.getElementById('saveAdminInactivityTimeout')?.addEventListener('click', saveAdminInactivityTimeout);
    document.getElementById('rolloverEndMonth')?.addEventListener('change', populateRolloverDays);
    document.getElementById('saveRolloverEndDate')?.addEventListener('click', saveRolloverEndDate);
    document.getElementById('rolloverSchoolYear')?.addEventListener('change', previewRollover);
    document.getElementById('previewRolloverBtn')?.addEventListener('click', previewRollover);
    document.getElementById('runRolloverBtn')?.addEventListener('click', runRollover);
    document.getElementById('reissueRolloverQrBtn')?.addEventListener('click', reissueRolloverQrCodes);

    document.querySelectorAll('.cal-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
}

function renderSmsSetting(enabled) {
    const toggle = document.getElementById('attendanceSmsToggle');
    const status = document.getElementById('attendanceSmsStatus');
    if (toggle) toggle.checked = enabled;
    if (status) status.textContent = enabled
        ? 'On — module SMS preferences decide which messages may be sent. The engine refreshes within about 15 seconds.'
        : 'Off — automated SMS will pause within about 15 seconds; module preferences are retained.';
}

async function loadSmsSetting() {
    const smsToggle = document.getElementById('attendanceSmsToggle');
    const securityToggle = document.getElementById('antiSpoofToggle');
    try {
        if (!supabaseClient) throw new Error('Supabase is not available');
        const settings = await AppSettings.load(supabaseClient, 'system', { refresh: true });
        savedSmsEnabled = AppSettings.enabled(settings, 'sms_enabled');
        savedAntiSpoofEnabled = AppSettings.enabled(settings, 'anti_spoof_enabled');
        renderSmsSetting(savedSmsEnabled);
        renderAntiSpoofSetting(savedAntiSpoofEnabled);
        const minutes = Number(settings.admin_inactivity_timeout_minutes);
        savedAdminInactivityMinutes = AppSettings.validAdminTimeoutMinutes(settings.admin_inactivity_timeout_minutes)
            ? minutes : 3;
        const input = document.getElementById('adminInactivityTimeout');
        const saveButton = document.getElementById('saveAdminInactivityTimeout');
        const timeoutStatus = document.getElementById('adminInactivityStatus');
        if (input) { input.value = String(savedAdminInactivityMinutes); input.disabled = false; }
        if (saveButton) saveButton.disabled = false;
        if (timeoutStatus) timeoutStatus.textContent = `Current timeout: ${savedAdminInactivityMinutes} minutes.`;
        if (smsToggle) smsToggle.disabled = false;
        if (securityToggle) securityToggle.disabled = false;
    } catch (error) {
        console.error('Could not load system settings:', error);
        if (smsToggle) smsToggle.disabled = true;
        if (securityToggle) securityToggle.disabled = true;
        const status = document.getElementById('attendanceSmsStatus');
        if (status) status.textContent = 'System settings unavailable. Refresh to try again.';
        const securityStatus = document.getElementById('antiSpoofStatus');
        if (securityStatus) securityStatus.textContent = 'Security setting unavailable. Refresh to try again.';
        const timeoutStatus = document.getElementById('adminInactivityStatus');
        if (timeoutStatus) timeoutStatus.textContent = 'Timeout setting unavailable. Refresh to try again.';
    }
}

async function saveAdminInactivityTimeout() {
    const input = document.getElementById('adminInactivityTimeout');
    const button = document.getElementById('saveAdminInactivityTimeout');
    const raw = input?.value.trim() || '';
    if (!AppSettings.validAdminTimeoutMinutes(raw)) {
        UIFeedback.fieldError(input, 'Enter a whole number of at least 3 minutes.');
        return;
    }
    button.disabled = true;
    try {
        await AppSettings.save(supabaseClient, 'system', { admin_inactivity_timeout_minutes: raw });
        const previous = savedAdminInactivityMinutes;
        savedAdminInactivityMinutes = Number(raw);
        document.getElementById('adminInactivityStatus').textContent =
            `Current timeout: ${savedAdminInactivityMinutes} minutes.`;
        window.AdminInactivity?.settingChanged();
        try {
            await logSystemAudit({ action: 'UPDATE', moduleName: 'system', pageName: 'system-settings.html',
                targetTable: 'system_settings', targetId: 'admin_inactivity_timeout_minutes',
                details: { setting: 'admin_inactivity_timeout_minutes', old_value: previous,
                    new_value: savedAdminInactivityMinutes } });
        } catch (auditError) {
            console.error('Admin inactivity timeout audit could not be recorded:', auditError);
        }
        UIFeedback.success(`Admin inactivity timeout saved: ${savedAdminInactivityMinutes} minutes.`);
    } catch (error) {
        console.error('Could not save Admin inactivity timeout:', error);
        UIFeedback.error('Could not save the Admin inactivity timeout. Please try again.');
    } finally {
        button.disabled = false;
    }
}

function renderAntiSpoofSetting(enabled) {
    const toggle = document.getElementById('antiSpoofToggle');
    const status = document.getElementById('antiSpoofStatus');
    if (toggle) toggle.checked = enabled;
    if (status) status.textContent = enabled
        ? 'On — the face engine applies its existing liveness check after its next settings refresh.'
        : 'Off — the face engine skips liveness checks after its next settings refresh.';
}

async function saveCapability(event, key) {
    const toggle = event.target;
    const enabled = toggle.checked;
    const previous = key === 'sms_enabled' ? savedSmsEnabled : savedAntiSpoofEnabled;
    toggle.disabled = true;
    if (key === 'sms_enabled' && !enabled && !await UIFeedback.confirm({
        title: 'Disable Master SMS?',
        message: 'Automated SMS for Entry & Exit and facial Event attendance will be disabled. Module preferences will be kept.',
        confirmText: 'Disable SMS', type: 'warning'
    })) {
        renderSmsSetting(previous);
        toggle.disabled = false;
        return;
    }
    if (key === 'anti_spoof_enabled' && !enabled && !await UIFeedback.confirm({
        title: 'Disable Anti-Spoof Protection?',
        message: 'Face scans in both modules will skip liveness verification while this is off.',
        confirmText: 'Disable protection', type: 'warning'
    })) {
        renderAntiSpoofSetting(previous);
        toggle.disabled = false;
        return;
    }
    try {
        await AppSettings.save(supabaseClient, 'system', { [key]: enabled });
        if (key === 'sms_enabled') {
            savedSmsEnabled = enabled;
            renderSmsSetting(enabled);
        } else {
            savedAntiSpoofEnabled = enabled;
            renderAntiSpoofSetting(enabled);
        }
        await logSystemAudit({ action: 'UPDATE', moduleName: 'system', pageName: 'system-settings.html',
            targetTable: 'system_settings', targetId: key,
            details: { setting: key, old_value: previous, new_value: enabled } });
        showAlert(`${key === 'sms_enabled' ? 'Master SMS' : 'Anti-Spoof Protection'} ${enabled ? 'enabled' : 'disabled'}.`, 'success');
    } catch (error) {
        console.error('Could not save system setting:', error);
        if (key === 'sms_enabled') renderSmsSetting(previous);
        else renderAntiSpoofSetting(previous);
        showAlert('Could not save system setting. Please try again.', 'danger');
    } finally {
        toggle.disabled = false;
    }
}

function switchTab(tabName) {
    const isSetActive = tabName === 'setActive';
    document.getElementById('tabSetActive')?.classList.toggle('active', isSetActive);
    document.getElementById('tabCreateNew')?.classList.toggle('active', !isSetActive);
    const panelSetActive = document.getElementById('panelSetActive');
    const panelCreate = document.getElementById('panelCreate');
    if (panelSetActive) panelSetActive.style.display = isSetActive ? '' : 'none';
    if (panelCreate) panelCreate.style.display = isSetActive ? 'none' : '';
}

function renderSchoolYearsSkeleton() {
    const select = document.getElementById('existingSchoolYearSelect');
    if (select) {
        select.innerHTML = '<option value="" disabled selected>Loading school years...</option>';
    }

    const banner = document.getElementById('activeSchoolYearBanner');
    if (banner) {
        banner.style.display = 'flex';
        // Don't overwrite innerHTML if the label element exists — just show loading state
        const label = document.getElementById('activeSchoolYearLabel');
        if (label) {
            label.innerHTML = '<span class="skeleton-block skeleton-line" style="max-width: 240px;"></span>';
        }
    }
}

async function loadSchoolYears() {
    renderSchoolYearsSkeleton();

    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        const { data: schoolYears, error } = await supabaseClient
            .from('school_years')
            .select('*')
            .order('start_date', { ascending: false });

        if (error) throw error;

        allSchoolYears = schoolYears || [];

        const active = allSchoolYears.find((sy) => sy.is_active);
        const banner = document.getElementById('activeSchoolYearBanner');
        const label = document.getElementById('activeSchoolYearLabel');

        if (active) {
            if (label) {
                label.textContent = `${active.name}  ·  ${formatDate(active.start_date)} \u2192 ${formatDate(active.end_date)}`;
            }
            if (banner) banner.style.display = 'flex';
        } else {
            if (banner) banner.style.display = 'none';
        }

        populateExistingSchoolYearsDropdown();
        populateRolloverYears();
    } catch (error) {
        console.error('Error loading school years:', error);
        showAlert('School years could not be loaded. Please try again.', 'danger');
    }
}

function populateRolloverYears() {
    const select = document.getElementById('rolloverSchoolYear');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    allSchoolYears.forEach(year => {
        const option = document.createElement('option');
        option.value = year.id;
        option.textContent = year.name;
        select.appendChild(option);
    });
    const manilaYear = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila', year: 'numeric'
    }).format(new Date()));
    const dueCandidate = allSchoolYears.find(year => Number(String(year.end_date).slice(0, 4)) <= manilaYear);
    select.value = allSchoolYears.some(year => year.id === previous)
        ? previous : (dueCandidate?.id || allSchoolYears.find(year => year.is_active)?.id || allSchoolYears[0]?.id || '');
}

function populateRolloverDays() {
    const month = Number(document.getElementById('rolloverEndMonth')?.value || 3);
    const daySelect = document.getElementById('rolloverEndDay');
    if (!daySelect) return;
    const previous = Number(daySelect.value || 25);
    const max = new Date(Date.UTC(2001, month, 0)).getUTCDate();
    daySelect.replaceChildren();
    for (let day = 1; day <= max; day++) {
        const option = document.createElement('option');
        option.value = String(day).padStart(2, '0');
        option.textContent = String(day);
        daySelect.appendChild(option);
    }
    daySelect.value = String(Math.min(previous, max)).padStart(2, '0');
}

async function loadRolloverControls() {
    const monthSelect = document.getElementById('rolloverEndMonth');
    const daySelect = document.getElementById('rolloverEndDay');
    const preview = document.getElementById('rolloverPreview');
    if (!monthSelect || !daySelect || !preview) return;
    monthSelect.replaceChildren();
    for (let month = 1; month <= 12; month++) {
        const option = document.createElement('option');
        option.value = String(month).padStart(2, '0');
        option.textContent = new Intl.DateTimeFormat('en-PH', { month: 'long', timeZone: 'UTC' })
            .format(new Date(Date.UTC(2001, month - 1, 1)));
        monthSelect.appendChild(option);
    }
    try {
        const settings = await AppSettings.load(supabaseClient, 'system', { refresh: true });
        const [month, day] = String(settings.school_year_end_month_day || '03-25').split('-');
        monthSelect.value = month;
        populateRolloverDays();
        daySelect.value = day;
        const selectedYear = document.getElementById('rolloverSchoolYear')?.value;
        if (selectedYear) {
            const { error } = await supabaseClient.rpc('preview_student_id_rollover', {
                p_school_year_id: selectedYear
            });
            if (error) throw error;
        }
        for (const id of ['rolloverEndMonth', 'rolloverEndDay', 'saveRolloverEndDate',
            'rolloverSchoolYear', 'previewRolloverBtn']) {
            document.getElementById(id).disabled = false;
        }
        await previewRollover();
    } catch (error) {
        console.error('Rollover configuration unavailable:', error);
        preview.textContent = 'Student ID rollover is unavailable until its database migration is installed.';
    }
}

async function saveRolloverEndDate() {
    const button = document.getElementById('saveRolloverEndDate');
    const month = document.getElementById('rolloverEndMonth')?.value;
    const day = document.getElementById('rolloverEndDay')?.value;
    if (!month || !day) return;
    button.disabled = true;
    try {
        await AppSettings.save(supabaseClient, 'system', {
            school_year_end_month_day: `${month}-${day}`
        });
        UIFeedback.success('School Year End Date saved.');
        await previewRollover();
    } catch (error) {
        console.error('Could not save rollover date:', error);
        UIFeedback.error('Could not save the School Year End Date.');
    } finally {
        button.disabled = false;
    }
}

async function previewRollover() {
    const yearId = document.getElementById('rolloverSchoolYear')?.value;
    const panel = document.getElementById('rolloverPreview');
    const runButton = document.getElementById('runRolloverBtn');
    const reissueButton = document.getElementById('reissueRolloverQrBtn');
    currentRolloverPreview = null;
    runButton.disabled = true;
    reissueButton.disabled = true;
    if (!yearId || !panel) return;
    panel.textContent = 'Checking students, sections, and ID conflicts...';
    try {
        const { data, error } = await supabaseClient.rpc('preview_student_id_rollover', {
            p_school_year_id: yearId
        });
        if (error) throw error;
        currentRolloverPreview = data;
        panel.dataset.ready = String(!!data.can_run);
        const header = document.createElement('strong');
        header.textContent = `${data.school_year} · eligible after ${data.eligible_after} (Manila)`;
        const list = document.createElement('ul');
        const lines = [
            `Eligible students: ${data.ready}`,
            `Invalid IDs: ${data.invalid}; unverified or conflicting student grades: ${data.grade_mismatch || 0}; target conflicts: ${data.collisions}`,
            `Grade 10 skipped: ${data.highest_grade}; inactive skipped: ${data.inactive}`,
            'Current student grade and Student ID advance together. Existing section assignments are preserved.',
            ...Object.entries(data.grade_progression || {}).map(([grade, count]) => `${grade}: ${count}`),
            data.last_completed_rollover
                ? `Last completed rollover: ${data.last_completed_rollover.school_year} on ${new Date(data.last_completed_rollover.executed_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`
                : 'Last completed rollover: None',
            data.next_scheduled_rollover
                ? `Next scheduled rollover: ${data.next_scheduled_rollover.school_year} on ${data.next_scheduled_rollover.due_date} at 12:05 AM Manila time`
                : 'Next scheduled rollover: Waiting for a following school year to be created',
            data.already_processed ? 'Already completed for this school year.'
                : data.next_school_year_id ? (data.can_run ? 'Ready to run.' : 'Pending; the daily job will retry.')
                    : 'No school year starting in the source year’s end year exists.'
        ];
        lines.forEach(line => {
            const item = document.createElement('li');
            item.textContent = line;
            list.appendChild(item);
        });
        panel.replaceChildren(header, list);
        if (data.completed_at) {
            const completed = document.createElement('small');
            completed.textContent = `Completed: ${new Date(data.completed_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`;
            panel.appendChild(completed);
        }
        if (Array.isArray(data.examples) && data.examples.length) {
            const examples = document.createElement('small');
            examples.textContent = `Examples: ${data.examples.map(item => `${item.current_grade} → ${item.next_grade} (${item.old} → ${item.new})`).join(', ')}`;
            panel.appendChild(examples);
        }
        if (Array.isArray(data.issues) && data.issues.length) {
            const issues = document.createElement('small');
            issues.textContent = `Blockers: ${data.issues.map(item => `${item.id} (${item.reason})`).join(', ')}`;
            panel.appendChild(issues);
        }
        runButton.disabled = !data.can_run;
        reissueButton.disabled = !data.already_processed;
    } catch (error) {
        console.error('Rollover preview failed:', error);
        panel.textContent = 'Could not load the rollover preview. Refresh and try again.';
    }
}

async function reissueRolloverQrCodes() {
    if (!currentRolloverPreview?.already_processed) return;
    const yearId = document.getElementById('rolloverSchoolYear')?.value;
    const button = document.getElementById('reissueRolloverQrBtn');
    const status = document.getElementById('rolloverQrStatus');
    button.disabled = true;
    try {
        let query = supabaseClient
            .from('student_id_rollover_qr_queue')
            .select('student_id')
            .eq('school_year_id', yearId).is('qr_reissued_at', null)
            .order('student_id').limit(25);
        if (qrReissueCursorByYear[yearId]) query = query.gt('student_id', qrReissueCursorByYear[yearId]);
        let { data: changes, error: changesError } = await query;
        if (!changes?.length && qrReissueCursorByYear[yearId] && !changesError) {
            qrReissueCursorByYear[yearId] = null;
            ({ data: changes, error: changesError } = await supabaseClient
                .from('student_id_rollover_qr_queue')
                .select('student_id')
                .eq('school_year_id', yearId).is('qr_reissued_at', null)
                .order('student_id').limit(25));
        }
        if (changesError) throw changesError;
        if (!changes?.length) {
            status.textContent = 'All QR emails for this rollover have been sent.';
            return;
        }
        if (!await UIFeedback.confirm({
            title: 'Email Updated Student QR Codes',
            message: `Send new UUID-based QR codes for up to ${changes.length} students now? Students without an email will remain pending.`,
            confirmText: 'Send QR Emails', type: 'warning'
        })) return;
        let sent = 0;
        let failed = 0;
        for (const change of changes) {
            const { data: student, error: studentError } = await supabaseClient
                .from('students')
                .select('student_id, stud_id, current_grade_level, first_name, middle_name, last_name, birth_date, gender, email, sections:section_id(section_name)')
                .eq('student_id', change.student_id).maybeSingle();
            if (studentError || !student?.email) { failed++; continue; }
            const section = student.sections || {};
            const response = await adminAal2Fetch('send-student-qr-email.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: student.email, studentId: student.stud_id,
                    firstName: student.first_name, middleName: student.middle_name,
                    lastName: student.last_name, birthDate: student.birth_date,
                    gender: student.gender,
                    sectionLabel: [student.current_grade_level, section.section_name].filter(Boolean).join(' - '),
                    qrPayload: `student_uuid:${student.student_id}`
                })
            }).catch(() => null);
            const result = response ? await response.json().catch(() => null) : null;
            if (!response?.ok || result?.success !== true) {
                failed++; continue;
            }
            const { data: marked, error: markError } = await supabaseClient
                .rpc('mark_student_rollover_qr_reissued', {
                    p_school_year_id: yearId, p_student_id: student.student_id
                });
            if (markError || !marked) { failed++; continue; }
            sent++;
            status.textContent = `QR emails sent: ${sent}; still needing attention in this batch: ${failed}.`;
        }
        qrReissueCursorByYear[yearId] = changes[changes.length - 1].student_id;
        status.textContent = `QR emails sent: ${sent}; pending or failed in this batch: ${failed}. Run again to retry pending students.`;
        if (failed) UIFeedback.toast({ type: 'warning', message: status.textContent });
        else UIFeedback.success(status.textContent);
    } catch (error) {
        console.error('QR reissue failed:', error);
        status.textContent = 'Could not finish QR reissue. Retry after checking the connection.';
        UIFeedback.error(status.textContent);
    } finally {
        button.disabled = false;
    }
}

async function runRollover() {
    if (!currentRolloverPreview?.can_run) return;
    const yearId = document.getElementById('rolloverSchoolYear')?.value;
    if (!await UIFeedback.confirm({
        title: 'Run Student ID Rollover',
        message: `Advance eligible student IDs for ${currentRolloverPreview.school_year}? This runs only once for this school year and old ID-only QR codes must be replaced.`,
        confirmText: 'Run Rollover', type: 'danger'
    })) return;
    const button = document.getElementById('runRolloverBtn');
    button.disabled = true;
    try {
        const { data, error } = await supabaseClient.rpc('run_student_id_rollover', {
            p_school_year_id: yearId
        });
        if (error) throw error;
        if (data.result === 'completed') UIFeedback.success(`${data.processed} student IDs advanced. Reissue their QR codes.`);
        else UIFeedback.toast({ type: 'warning', message: 'Rollover is pending or already complete. Review the preview.' });
        await previewRollover();
    } catch (error) {
        console.error('Rollover failed:', error);
        UIFeedback.error('No students were changed. Review the preview and try again.');
        await previewRollover();
    }
}

function populateExistingSchoolYearsDropdown() {
    const select = document.getElementById('existingSchoolYearSelect');
    if (!select) return;

    const previousValue = select.value;

    if (allSchoolYears.length === 0) {
        select.innerHTML = '<option value="" disabled selected>No school years created yet</option>';
        hideDetailsCard();
        return;
    }

    select.innerHTML = '<option value="" disabled selected>Select a school year...</option>';
    allSchoolYears.forEach((sy) => {
        const opt = document.createElement('option');
        opt.value = sy.id;
        opt.textContent = sy.is_active ? `${sy.name} (Active)` : sy.name;
        select.appendChild(opt);
    });

    if (previousValue && allSchoolYears.some(sy => String(sy.id) === previousValue)) {
        select.value = previousValue;
        renderDetailsCard(previousValue);
    } else {
        hideDetailsCard();
    }
}

function handleSelectChange() {
    const select = document.getElementById('existingSchoolYearSelect');
    renderDetailsCard(select?.value);
}

function renderDetailsCard(schoolYearId) {
    const card = document.getElementById('syDetailsCard');
    const activateBtn = document.getElementById('setActiveSchoolYearBtn');
    const inactivateBtn = document.getElementById('inactivateSchoolYearBtn');
    const chosen = allSchoolYears.find(sy => String(sy.id) === String(schoolYearId));

    if (!chosen) {
        hideDetailsCard();
        return;
    }

    const startEl = document.getElementById('syDetailStart');
    const endEl = document.getElementById('syDetailEnd');
    const statusEl = document.getElementById('syDetailStatus');

    if (startEl) startEl.textContent = formatDate(chosen.start_date);
    if (endEl) endEl.textContent = formatDate(chosen.end_date);

    if (statusEl) {
        statusEl.textContent = chosen.is_active ? 'Active' : 'Inactive';
        statusEl.className = `status-badge ${chosen.is_active ? 'active' : 'inactive'}`;
    }

    if (card) card.style.display = 'block';
    if (activateBtn) activateBtn.disabled = !!chosen.is_active;
    if (inactivateBtn) inactivateBtn.disabled = !chosen.is_active;
}

function hideDetailsCard() {
    const card = document.getElementById('syDetailsCard');
    if (card) card.style.display = 'none';
    const activateBtn = document.getElementById('setActiveSchoolYearBtn');
    const inactivateBtn = document.getElementById('inactivateSchoolYearBtn');
    if (activateBtn) activateBtn.disabled = true;
    if (inactivateBtn) inactivateBtn.disabled = true;
}

async function handleSetActiveClick() {
    const select = document.getElementById('existingSchoolYearSelect');
    const activateBtn = document.getElementById('setActiveSchoolYearBtn');
    const selectedId = select?.value;
    const chosen = allSchoolYears.find(sy => String(sy.id) === String(selectedId));

    if (!chosen) {
        showAlert('Please select a school year first.', 'warning');
        return;
    }

    if (!await UIFeedback.confirm({
        title: 'Activate School Year',
        message: `Set "${chosen.name}" as the active school year? This will deactivate the current active year.`,
        confirmText: 'Activate',
        type: 'warning'
    })) {
        return;
    }

    try {
        if (activateBtn) {
            activateBtn.disabled = true;
            activateBtn.textContent = 'Activating...';
        }

        await activateSchoolYear(selectedId);
        showAlert(`School year "${chosen.name}" is now active.`, 'success');
        await loadSchoolYears();
        if (select) select.value = selectedId;
        renderDetailsCard(selectedId);
    } catch (error) {
        console.error('Error activating school year:', error);
        showAlert('The school year could not be activated. Please try again.', 'danger');
    } finally {
        if (activateBtn) activateBtn.textContent = 'Activate School Year';
    }
}

async function handleInactivateClick() {
    const select = document.getElementById('existingSchoolYearSelect');
    const inactivateBtn = document.getElementById('inactivateSchoolYearBtn');
    const selectedId = select?.value;
    const chosen = allSchoolYears.find(sy => String(sy.id) === String(selectedId));

    if (!chosen || !chosen.is_active) {
        showAlert('Only the active school year can be inactivated.', 'warning');
        return;
    }

    if (!await UIFeedback.confirm({
        title: 'Inactivate School Year',
        message: `Inactivate "${chosen.name}"? No school year will be marked active until you activate one.`,
        confirmText: 'Inactivate',
        type: 'warning'
    })) {
        return;
    }

    try {
        if (inactivateBtn) {
            inactivateBtn.disabled = true;
            inactivateBtn.textContent = 'Inactivating...';
        }

        const { error } = await supabaseClient
            .from('school_years')
            .update({ is_active: false })
            .eq('id', selectedId);

        if (error) throw error;

        showAlert(`School year "${chosen.name}" has been inactivated.`, 'success');
        await loadSchoolYears();
        if (select) select.value = selectedId;
        renderDetailsCard(selectedId);
    } catch (error) {
        console.error('Error inactivating school year:', error);
        showAlert('The school year could not be inactivated. Please try again.', 'danger');
    } finally {
        if (inactivateBtn) inactivateBtn.textContent = 'Inactivate School Year';
    }
}

async function createSchoolYear() {
    if (creatingSchoolYear) return;
    creatingSchoolYear = true;
    const createButton = document.getElementById('createSchoolYearBtn');
    if (createButton) createButton.disabled = true;
    try {
        if (!supabaseClient) {
            showAlert('Database connection not initialized.', 'danger');
            return;
        }

        const input = document.getElementById('schoolYearInput');
        const name = String(input?.value || '').trim();
        const activate = document.getElementById('activateOnCreate')?.checked;

        if (!name) {
            UIFeedback.fieldError(input, 'Please enter a school year.');
            return;
        }

        const match = name.match(/^(\d{4})-(\d{4})$/);
        if (!match) {
            UIFeedback.fieldError(input, 'Use YYYY-YYYY (example: 2027-2028).');
            return;
        }

        const startYear = Number(match[1]);
        const endYear = Number(match[2]);
        if (endYear !== startYear + 1) {
            UIFeedback.fieldError(input, 'School years must be consecutive (example: 2027-2028).');
            return;
        }

        const { data: existing, error: existingError } = await supabaseClient
            .from('school_years')
            .select('id')
            .eq('name', name)
            .maybeSingle();

        if (existingError) throw existingError;
        if (existing) {
            UIFeedback.fieldError(input, 'This school year already exists.');
            return;
        }

        const startDate = `${startYear}-06-01`;
        const endDate = `${endYear}-03-31`;

        const { data: inserted, error: insertError } = await supabaseClient
            .from('school_years')
            .insert([{
                name,
                start_date: startDate,
                end_date: endDate,
                is_active: false,
                created_at: new Date().toISOString(),
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        if (activate) {
            await activateSchoolYear(inserted.id);
            showAlert(`School year "${name}" saved and activated.`, 'success');
        } else {
            showAlert(`School year "${name}" saved.`, 'success');
        }

        if (input) input.value = '';
        await loadSchoolYears();
        switchTab('setActive');
        const select = document.getElementById('existingSchoolYearSelect');
        if (select) {
            select.value = inserted.id;
            renderDetailsCard(inserted.id);
        }
    } catch (error) {
        console.error('Error creating school year:', error);
        showAlert('The school year could not be saved. Please try again.', 'danger');
    } finally {
        creatingSchoolYear = false;
        if (createButton) createButton.disabled = false;
    }
}

async function activateSchoolYear(schoolYearId) {
    const { error: resetError } = await supabaseClient
        .from('school_years')
        .update({ is_active: false })
        .gte('created_at', '1970-01-01');

    if (resetError) throw resetError;

    const { error: activateError } = await supabaseClient
        .from('school_years')
        .update({ is_active: true })
        .eq('id', schoolYearId);

    if (activateError) throw activateError;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function showAlert(message, type = 'info') {
    if (type === 'success') {
        UIFeedback.success(message);
        return;
    }
    if (type === 'danger') {
        UIFeedback.error(message, 'Action failed');
        return;
    }
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.setAttribute('role', 'alert');
    alertDiv.textContent = message;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn-close';
    closeButton.setAttribute('data-bs-dismiss', 'alert');
    closeButton.setAttribute('aria-label', 'Close');
    alertDiv.appendChild(closeButton);
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        mainContent.insertBefore(alertDiv, mainContent.firstChild);
    }
    setTimeout(() => alertDiv.remove(), 5000);
}
