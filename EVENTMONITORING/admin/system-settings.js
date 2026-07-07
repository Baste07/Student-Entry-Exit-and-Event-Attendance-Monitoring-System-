let allSchoolYears = [];

document.addEventListener('DOMContentLoaded', async () => {
    checkSupabaseConnection();
    setupEventListeners();
    await loadSchoolYears();
});

function setupEventListeners() {
    document.getElementById('createSchoolYearBtn')?.addEventListener('click', createSchoolYear);
    document.getElementById('setActiveSchoolYearBtn')?.addEventListener('click', handleSetActiveClick);
    document.getElementById('inactivateSchoolYearBtn')?.addEventListener('click', handleInactivateClick);
    document.getElementById('existingSchoolYearSelect')?.addEventListener('change', handleSelectChange);

    document.querySelectorAll('.cal-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
}

function switchTab(tabName) {
    const isSetActive = tabName === 'setActive';
    document.getElementById('tabSetActive').classList.toggle('active', isSetActive);
    document.getElementById('tabCreateNew').classList.toggle('active', !isSetActive);
    document.getElementById('panelSetActive').style.display = isSetActive ? '' : 'none';
    document.getElementById('panelCreate').style.display = isSetActive ? 'none' : '';
}

async function loadSchoolYears() {
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
            label.textContent = `${active.name}  ·  ${formatDate(active.start_date)} \u2192 ${formatDate(active.end_date)}`;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }

        populateExistingSchoolYearsDropdown();
    } catch (error) {
        console.error('Error loading school years:', error);
        showAlert('Error loading school years: ' + error.message, 'danger');
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

    document.getElementById('syDetailStart').textContent = formatDate(chosen.start_date);
    document.getElementById('syDetailEnd').textContent = formatDate(chosen.end_date);

    const statusEl = document.getElementById('syDetailStatus');
    statusEl.textContent = chosen.is_active ? 'Active' : 'Inactive';
    statusEl.className = `status-badge ${chosen.is_active ? 'active' : 'inactive'}`;

    card.style.display = 'block';
    activateBtn.disabled = !!chosen.is_active;
    inactivateBtn.disabled = !chosen.is_active;
}

function hideDetailsCard() {
    const card = document.getElementById('syDetailsCard');
    if (card) card.style.display = 'none';
    document.getElementById('setActiveSchoolYearBtn').disabled = true;
    document.getElementById('inactivateSchoolYearBtn').disabled = true;
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

    if (!confirm(`Set "${chosen.name}" as the active school year? This will deactivate the current active year.`)) {
        return;
    }

    try {
        activateBtn.disabled = true;
        activateBtn.textContent = 'Activating...';

        await activateSchoolYear(selectedId);
        showAlert(`School year "${chosen.name}" is now active.`, 'success');
        await loadSchoolYears();
        select.value = selectedId;
        renderDetailsCard(selectedId);
    } catch (error) {
        console.error('Error activating school year:', error);
        showAlert('Error activating school year: ' + error.message, 'danger');
    } finally {
        activateBtn.textContent = 'Activate School Year';
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

    if (!confirm(`Inactivate "${chosen.name}"? No school year will be marked active until you activate one.`)) {
        return;
    }

    try {
        inactivateBtn.disabled = true;
        inactivateBtn.textContent = 'Inactivating...';

        const { error } = await supabaseClient
            .from('school_years')
            .update({ is_active: false })
            .eq('id', selectedId);

        if (error) throw error;

        showAlert(`School year "${chosen.name}" has been inactivated.`, 'success');
        await loadSchoolYears();
        select.value = selectedId;
        renderDetailsCard(selectedId);
    } catch (error) {
        console.error('Error inactivating school year:', error);
        showAlert('Error inactivating school year: ' + error.message, 'danger');
    } finally {
        inactivateBtn.textContent = 'Inactivate School Year';
    }
}

async function createSchoolYear() {
    try {
        if (!supabaseClient) {
            showAlert('Database connection not initialized.', 'danger');
            return;
        }

        const input = document.getElementById('schoolYearInput');
        const name = String(input?.value || '').trim();
        const activate = document.getElementById('activateOnCreate')?.checked;

        if (!name) {
            showAlert('Please enter a school year.', 'warning');
            return;
        }

        const match = name.match(/^(\d{4})-(\d{4})$/);
        if (!match) {
            showAlert('School year must be in format YYYY-YYYY (example: 2027-2028).', 'warning');
            return;
        }

        const startYear = Number(match[1]);
        const endYear = Number(match[2]);
        if (endYear !== startYear + 1) {
            showAlert('School year must be consecutive (example: 2027-2028).', 'warning');
            return;
        }

        const { data: existing, error: existingError } = await supabaseClient
            .from('school_years')
            .select('id')
            .eq('name', name)
            .maybeSingle();

        if (existingError) throw existingError;
        if (existing) {
            showAlert('This school year already exists.', 'warning');
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

        input.value = '';
        await loadSchoolYears();
        switchTab('setActive');
        document.getElementById('existingSchoolYearSelect').value = inserted.id;
        renderDetailsCard(inserted.id);
    } catch (error) {
        console.error('Error creating school year:', error);
        showAlert('Error creating school year: ' + error.message, 'danger');
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
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.setAttribute('role', 'alert');
    alertDiv.innerHTML = `${message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    const mainContent = document.querySelector('.main-content');
    mainContent.insertBefore(alertDiv, mainContent.firstChild);
    setTimeout(() => alertDiv.remove(), 5000);
}