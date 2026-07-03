/* =========================================================
   system-settings.js
   ========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    checkSupabaseConnection();
    await loadSystemSettings();
    setupEventListeners();
});

/* ── Event Listeners ── */
function setupEventListeners() {
    document.getElementById('saveAcademicSettings').addEventListener('click', saveAcademicSettings);
    document.getElementById('inactivateSemesterBtn').addEventListener('click', inactivateSemester);
    document.getElementById('createSemesterBtn').addEventListener('click', createSemester);
    document.getElementById('saveFeatureSettings').addEventListener('click', saveFeatureSettings);

    // Show semester details when user picks one from the dropdown
    document.getElementById('activeSemester').addEventListener('change', previewSemester);

    const departmentSelect = document.getElementById('departmentSelect');
    if (departmentSelect) departmentSelect.addEventListener('change', loadDepartmentDetails);

    const departmentLogoFile = document.getElementById('departmentLogoFile');
    if (departmentLogoFile) departmentLogoFile.addEventListener('change', previewDepartmentLogo);

    const saveDepartmentLogo = document.getElementById('saveDepartmentLogo');
    if (saveDepartmentLogo) saveDepartmentLogo.addEventListener('click', saveDepartmentLogoHandler);

    const clearDepartmentLogoBtn = document.getElementById('clearDepartmentLogoBtn');
    if (clearDepartmentLogoBtn) clearDepartmentLogoBtn.addEventListener('click', clearDepartmentSelection);
}

/* ── Tab switcher ── */
function switchCalTab(tab) {
    const isCreate = tab === 'create';
    document.getElementById('panelSetActive').style.display = isCreate ? 'none' : 'flex';
    document.getElementById('panelCreate').style.display  = isCreate ? 'flex' : 'none';
    document.getElementById('tabSetActive').classList.toggle('active', !isCreate);
    document.getElementById('tabCreate').classList.toggle('active',  isCreate);
}

/* ── Load everything on page boot ── */
async function loadSystemSettings() {
    try {
        if (!supabaseClient) { console.error('Supabase client not initialized'); return; }

        const { data, error } = await supabaseClient
            .from('system_settings')
            .select('*')
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        if (data) populateSettings(data);

        await loadSemesters(data?.active_semester_id ?? null);
        await loadDepartments();
    } catch (error) {
        console.error('Error loading system settings:', error);
    }
}

/* ── Populate form from DB row ── */
function populateSettings(settings) {
    if (settings.features) {
        const features = typeof settings.features === 'string'
            ? JSON.parse(settings.features) : settings.features;

        if (features.faculty_requirements !== undefined)
            document.getElementById('facultyRequirements').checked = features.faculty_requirements;
        if (features.time_monitoring !== undefined)
            document.getElementById('timeMonitoring').checked = features.time_monitoring;
        if (features.thesis_archiving !== undefined)
            document.getElementById('thesisArchiving').checked = features.thesis_archiving;
        if (features.student_violations !== undefined)
            document.getElementById('studentViolations').checked = features.student_violations;
    }
}

/* ── Load semesters into the dropdown ── */
async function loadSemesters(activeSemesterId = null) {
    try {
        if (!supabaseClient) { console.error('Supabase client not initialized'); return; }

        const { data: semesters, error } = await supabaseClient
            .from('semesters')
            .select('*')
            .order('start_date', { ascending: false });

        if (error) throw error;

        const semesterSelect = document.getElementById('activeSemester');
        // Remove all options except placeholder
        while (semesterSelect.children.length > 1) semesterSelect.removeChild(semesterSelect.lastChild);

        let activeRecord = null;

        if (semesters && semesters.length > 0) {
            semesters.forEach(sem => {
                const option = document.createElement('option');
                option.value = sem.id;
                option.textContent = sem.name;
                option.dataset.startDate = sem.start_date;
                option.dataset.endDate   = sem.end_date;
                option.dataset.isActive  = sem.is_active;
                semesterSelect.appendChild(option);

                if (sem.is_active || sem.id === activeSemesterId) activeRecord = sem;
            });
            if (activeRecord) {
                semesterSelect.value = activeRecord.id;
                previewSemester();      
                showActiveBanner(activeRecord);
            } else {
                semesterSelect.value = '';
                document.getElementById('semesterPreview').style.display = 'none';
                showActiveBanner(null);
            }
        } else {
            semesterSelect.value = '';
            document.getElementById('semesterPreview').style.display = 'none';
            showActiveBanner(null);
        }
    } catch (error) {
        console.error('Error loading semesters:', error);
        showAlert('Error loading semesters: ' + error.message, 'danger');
    }
}

function previewSemester() {
    const select  = document.getElementById('activeSemester');
    const preview = document.getElementById('semesterPreview');
    const opt     = select.options[select.selectedIndex];

    if (!opt || !opt.value) { preview.style.display = 'none'; return; }

    document.getElementById('previewStart').textContent  = formatDate(opt.dataset.startDate);
    document.getElementById('previewEnd').textContent    = formatDate(opt.dataset.endDate);
    document.getElementById('previewStatus').innerHTML   =
        opt.dataset.isActive === 'true'
            ? '<span class="status-badge active">Active</span>'
            : '<span class="status-badge inactive">Inactive</span>';

    preview.style.display = 'block';
}

function showActiveBanner(sem) {
    const banner = document.getElementById('activeSemesterBanner');
    const label  = document.getElementById('activeSemesterLabel');
    if (!sem) { banner.style.display = 'none'; return; }
    label.textContent = `${sem.name}  ·  ${formatDate(sem.start_date)} → ${formatDate(sem.end_date)}`;
    banner.style.display = 'flex';
}

async function saveAcademicSettings() {
    try {
        const selectedSemesterId = document.getElementById('activeSemester').value;
        if (!selectedSemesterId) { showAlert('Please select a semester to activate.', 'warning'); return; }

        await activateSemester(selectedSemesterId);
        showAlert('Active semester updated successfully.', 'success');
        await loadSemesters(selectedSemesterId);
    } catch (error) {
        console.error('Error saving academic settings:', error);
        showAlert('Error saving academic settings: ' + error.message, 'danger');
    }
}

async function inactivateSemester() {
    try {
        const { data: activeSem, error: findError } = await supabaseClient
            .from('semesters')
            .select('id, name')
            .eq('is_active', true)
            .single();

        if (findError || !activeSem) { showAlert('No active semester to inactivate.', 'warning'); return; }

        const { error: updateError } = await supabaseClient
            .from('semesters')
            .update({ is_active: false })
            .eq('id', activeSem.id);
        if (updateError) throw updateError;

        await updateSystemSettings({
            active_semester_id : null,
            updated_at         : new Date().toISOString()
        });

        showAlert(`Semester "${activeSem.name}" has been inactivated.`, 'success');
        await loadSemesters(null);
    } catch (error) {
        console.error('Error inactivating semester:', error);
        showAlert('Error inactivating semester: ' + error.message, 'danger');
    }
}



async function createSemester() {
    try {
        const name      = document.getElementById('newSemName').value.trim();
        const startDate = document.getElementById('newSemStart').value;
        const endDate   = document.getElementById('newSemEnd').value;
        const activate  = document.getElementById('activateOnCreate').checked;

        if (!name)      { showAlert('Please enter a semester name.',       'warning'); return; }
        if (!startDate) { showAlert('Please choose a start date.',         'warning'); return; }
        if (!endDate)   { showAlert('Please choose an end date.',          'warning'); return; }
        if (endDate <= startDate) { showAlert('End date must be after start date.', 'warning'); return; }

        const { data: newSem, error: insertError } = await supabaseClient
            .from('semesters')
            .insert([{
                name,
                start_date : startDate,
                end_date   : endDate,
                is_active  : false,
                created_at : new Date().toISOString()
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        if (activate) {
            await activateSemester(newSem.id);
            showAlert(`Semester "${name}" created and set as active.`, 'success');
        } else {
            showAlert(`Semester "${name}" created successfully.`, 'success');
        }

        // Clear create form
        document.getElementById('newSemName').value  = '';
        document.getElementById('newSemType').value  = '';
        document.getElementById('newSemStart').value = '';
        document.getElementById('newSemEnd').value   = '';
        document.getElementById('activateOnCreate').checked = true;

        // Switch back to "Set Active" tab and reload list
        switchCalTab('set');
        await loadSemesters(activate ? newSem.id : null);
    } catch (error) {
        console.error('Error creating semester:', error);
        showAlert('Error creating semester: ' + error.message, 'danger');
    }
}

async function activateSemester(semesterId) {
    const { error: resetError } = await supabaseClient
        .from('semesters')
        .update({ is_active: false })
        .gte('created_at', '1970-01-01');
    if (resetError) throw resetError;

    const { error: updateError } = await supabaseClient
        .from('semesters')
        .update({ is_active: true })
        .eq('id', semesterId);
    if (updateError) throw updateError;

    await updateSystemSettings({
        active_semester_id : semesterId,
        updated_at         : new Date().toISOString()
    });
}



async function saveFeatureSettings() {
    try {
        const features = {
            faculty_requirements : document.getElementById('facultyRequirements').checked,
            time_monitoring      : document.getElementById('timeMonitoring').checked,
            thesis_archiving     : document.getElementById('thesisArchiving').checked,
            student_violations   : document.getElementById('studentViolations').checked
        };
        await updateSystemSettings({ features: JSON.stringify(features), updated_at: new Date().toISOString() });
        showAlert('Feature settings saved successfully.', 'success');
    } catch (error) {
        console.error('Error saving feature settings:', error);
        showAlert('Error saving feature settings: ' + error.message, 'danger');
    }
}

async function updateSystemSettings(settingsData) {
    if (!supabaseClient) throw new Error('Supabase client not initialized');

    const { data: existing, error: checkError } = await supabaseClient
        .from('system_settings')
        .select('id')
        .single();
    if (checkError && checkError.code !== 'PGRST116') {
        console.warn('Warning querying system_settings:', checkError);
    }

    if (existing) {
        const { error } = await supabaseClient
            .from('system_settings')
            .update(settingsData)
            .eq('id', existing.id);
        if (error) throw error;
    } else {
        const { error } = await supabaseClient
            .from('system_settings')
            .insert([settingsData]);
        if (error) throw error;
    }
}

async function getActiveSemester() {
    try {
        if (!supabaseClient) throw new Error('Supabase not initialised');

        const { data: settings } = await supabaseClient
            .from('system_settings')
            .select('active_semester_id')
            .single();

        if (settings?.active_semester_id) {
            const { data: sem, error } = await supabaseClient
                .from('semesters')
                .select('*')
                .eq('id', settings.active_semester_id)
                .single();
            if (!error && sem) return sem;
        }
        const { data: fallback, error: fbErr } = await supabaseClient
            .from('semesters')
            .select('*')
            .eq('is_active', true)
            .single();

        if (!fbErr && fallback) return fallback;

        return null;  
    } catch (err) {
        console.error('getActiveSemester error:', err);
        return null;
    }
}

async function loadDepartments() {
    try {
        if (!supabaseClient) { console.error('Supabase client not initialized'); return; }

        const { data: departments, error } = await supabaseClient
            .from('departments')
            .select('id, department_name, department_code, logo_url, is_active')
            .eq('is_active', true)
            .order('department_name', { ascending: true });

        if (error) throw error;

        const departmentSelect = document.getElementById('departmentSelect');
        if (departmentSelect && departments && departments.length > 0) {
            while (departmentSelect.children.length > 1)
                departmentSelect.removeChild(departmentSelect.lastChild);

            departments.forEach(dept => {
                const option = document.createElement('option');
                option.value = dept.id;
                option.textContent = `${dept.department_name} (${dept.department_code})`;
                option.dataset.deptName = dept.department_name;
                option.dataset.deptCode = dept.department_code;
                option.dataset.logoUrl  = dept.logo_url || '';
                departmentSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading departments:', error);
        showAlert('Error loading departments: ' + error.message, 'danger');
    }
}

function loadDepartmentDetails(event) {
    const selectedDeptId  = event.target.value;
    const detailsContainer = document.getElementById('departmentDetailsContainer');

    if (!selectedDeptId) { detailsContainer.style.display = 'none'; clearDepartmentSelection(); return; }

    const selectedOption = event.target.options[event.target.selectedIndex];
    document.getElementById('deptName').value = selectedOption.dataset.deptName;
    document.getElementById('deptCode').value = selectedOption.dataset.deptCode;

    const logoUrl     = selectedOption.dataset.logoUrl;
    const currentLogo = document.getElementById('currentDeptLogo');
    const noLogoText  = document.getElementById('noLogoText');

    if (logoUrl && logoUrl !== '') {
        currentLogo.src = logoUrl;
        currentLogo.style.display = 'block';
        noLogoText.style.display  = 'none';
    } else {
        currentLogo.style.display = 'none';
        noLogoText.style.display  = 'block';
    }

    document.getElementById('departmentLogoFile').value = '';
    document.getElementById('newLogoPreview').style.display = 'none';
    detailsContainer.style.display = 'block';
}

function previewDepartmentLogo(event) {
    const file = event.target.files[0];
    if (!file) return;
    const preview = document.getElementById('newLogoPreview');
    const img     = document.getElementById('newDeptLogo');
    if (preview && img) { img.src = URL.createObjectURL(file); preview.style.display = 'block'; }
}

function clearDepartmentSelection() {
    document.getElementById('departmentSelect').value = '';
    document.getElementById('departmentDetailsContainer').style.display = 'none';
    document.getElementById('departmentLogoFile').value = '';
    document.getElementById('newLogoPreview').style.display = 'none';
}

const DEPARTMENT_LOGO_BUCKET = 'dept-logos';

async function saveDepartmentLogoHandler() {
    try {
        const departmentSelect = document.getElementById('departmentSelect');
        const selectedDeptId   = departmentSelect.value;
        if (!selectedDeptId) { showAlert('Please select a department first.', 'warning'); return; }

        const departmentLogoFile = document.getElementById('departmentLogoFile').files[0];
        if (!departmentLogoFile) { showAlert('Please select a logo file to upload.', 'warning'); return; }

        const MAX_SIZE = 2 * 1024 * 1024;
        const ALLOWED  = ['image/png','image/jpeg','image/jpg','image/webp','image/svg+xml'];
        if (!ALLOWED.includes(departmentLogoFile.type)) { showAlert('Invalid file type. Please upload PNG, JPG, WEBP, or SVG.', 'warning'); return; }
        if (departmentLogoFile.size > MAX_SIZE)          { showAlert('File too large. Maximum allowed size is 2 MB.', 'warning'); return; }

        const ext      = departmentLogoFile.name.split('.').pop().toLowerCase();
        const filePath = `departments/${selectedDeptId}/logo.${ext}`;
        const allExts = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
        const staleFiles = allExts.map(e => `departments/${selectedDeptId}/logo.${e}`);
        await supabaseClient.storage.from(DEPARTMENT_LOGO_BUCKET).remove(staleFiles);

        const { error: uploadError } = await supabaseClient.storage
            .from(DEPARTMENT_LOGO_BUCKET)
            .upload(filePath, departmentLogoFile, {
                cacheControl : '3600',
                upsert       : false,  
                contentType  : departmentLogoFile.type
            });
        if (uploadError) throw uploadError;

        const { data: urlData } = supabaseClient.storage
            .from(DEPARTMENT_LOGO_BUCKET)
            .getPublicUrl(filePath);
        const logoUrlDisplay = `${urlData.publicUrl}?t=${Date.now()}`;

        const { data: updatedRows, error: updateError } = await supabaseClient
            .from('departments')
            .update({ logo_url: logoUrlDisplay, updated_at: new Date().toISOString() })
            .eq('id', selectedDeptId)
            .select();

        console.log('departments UPDATE result:', updatedRows, updateError);

        if (updateError) throw updateError;
        if (!updatedRows || updatedRows.length === 0) {
            throw new Error('Logo uploaded but departments table was not updated — check RLS UPDATE policy on the departments table.');
        }

        await loadDepartments();

        const currentLogo = document.getElementById('currentDeptLogo');
        const noLogoText  = document.getElementById('noLogoText');
        currentLogo.src = logoUrlDisplay;
        currentLogo.style.display = 'block';
        noLogoText.style.display  = 'none';

        document.getElementById('departmentLogoFile').value = '';
        document.getElementById('newLogoPreview').style.display = 'none';
        showAlert('Department logo uploaded successfully.', 'success');
    } catch (error) {
        console.error('Error saving department logo:', error);
        showAlert('Error saving department logo: ' + error.message, 'danger');
    }
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00');  
    return d.toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' });
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.setAttribute('role', 'alert');
    alertDiv.innerHTML = `${message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    const mainContent = document.querySelector('.main-content');
    mainContent.insertBefore(alertDiv, mainContent.firstChild);
    setTimeout(() => alertDiv.remove(), 5000);
}