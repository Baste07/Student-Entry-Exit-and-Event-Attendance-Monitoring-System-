/* ═══════════════════════════════════════════════════════════
   events.js — Events Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / events.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allEvents = [];
const todayISO = new Date().toLocaleDateString('en-CA');

// Multi-select globals
let selectedGrades = new Set();
let selectedSections = new Set();
let allSectionsData = [];

// Student modal globals
let modalSelectedStudentIds = new Set();
let modalAvailableStudents = [];
const studentCache = new Map();
let selectedStudentIds = new Set();
let currentEventParticipants = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    loadGradeLevels();
    loadEvents();
    bindEvents();

    // Auto-update statuses every 30 seconds
    setInterval(() => {
        if (allEvents.length > 0) {
            updateEventStatusesLocal();
        }
    }, 30000);
});

// ══════════════════════════════════════════════════════════
// DYNAMIC STATUS COMPUTATION
// ══════════════════════════════════════════════════════════

function getManilaNow() {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}
function computeEventStatus(event) {
    if (event.status === 'cancelled') return 'cancelled';

    const now = getManilaNow();
    const todayStr = now.toLocaleDateString('en-CA');
    const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

    const startDate = event.event_date;
    const endDate = event.end_date || event.event_date; // <-- FIX: fallback to event_date if no end_date
    const startTime = event.time_start;
    const endTime = event.time_end;

    // ── Already past the end date ──
    if (endDate < todayStr) {
        return 'completed';
    }

    // ── Same day as end date ──
    if (endDate === todayStr) {
        // If we have an end time and current time is past it → completed
        if (endTime && currentTime >= endTime) {
            return 'completed';
        }
        // If we have a start time and current time is before it → upcoming
        if (startTime && currentTime < startTime) {
            return 'upcoming';
        }
        // Otherwise we're between start and end (or no times set) → ongoing
        return 'ongoing';
    }

    // ── Before the start date ──
    if (startDate > todayStr) {
        return 'upcoming';
    }

    // ── Start date is today, but end date is later (multi-day) ──
    if (startDate === todayStr) {
        if (startTime && currentTime < startTime) {
            return 'upcoming';
        }
        return 'ongoing';
    }

    // ── Start date passed, end date hasn't arrived yet (multi-day spanning) ──
    if (startDate < todayStr && endDate > todayStr) {
        return 'ongoing';
    }

    return 'upcoming';
}
async function updateEventStatusesLocal() {
    const updates = [];

    allEvents.forEach(ev => {
        if (ev.status === 'cancelled') return;

        const computed = computeEventStatus(ev);
        // Compare against the REAL DB status (ev.status), not a locally mutated one
        if (computed !== ev.status) {
            updates.push({ event_id: ev.event_id, status: computed });
        }
    });

    if (updates.length === 0) return;

    // Update UI immediately so it feels responsive
    updateBadges();
    renderTable(allEvents);

    for (const upd of updates) {
        try {
            const { error } = await supabaseClient
                .from('events')
                .update({ status: upd.status, updated_at: new Date().toISOString() })
                .eq('event_id', upd.event_id);

            if (error) throw error;

            // Only adopt the new status locally once the DB confirms it
            const ev = allEvents.find(e => e.event_id === upd.event_id);
            if (ev) ev.status = upd.status;

        } catch (err) {
            console.error('Status sync failed for', upd.event_id, err);
            // If it fails, ev.status stays as the DB value, so the next
            // 30-second interval will retry automatically.
        }
    }
}

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════

async function loadGradeLevels() {
    try {
   const { data, error } = await supabaseClient
    .from('sections')
    .select('section_id, grade_level, section_name')
    .order('grade_level');

        if (error) throw error;

        allSectionsData = data || [];
        const grades = [...new Set(allSectionsData.map(s => s.grade_level).filter(Boolean))];
        if (grades.length === 0) grades.push('Grade 11', 'Grade 12');

        renderGradeOptions(grades);
        renderSectionOptions([]);

        const modalFilter = document.getElementById('modalFilterGrade');
        if (modalFilter) {
            modalFilter.innerHTML = '<option value="">All Grades</option>';
            grades.forEach(g => modalFilter.add(new Option(g, g)));
        }

    } catch (err) {
        console.error('loadGradeLevels error:', err);
        const fallback = ['Grade 11', 'Grade 12'];
        renderGradeOptions(fallback);
        renderSectionOptions([]);
    }
}
async function loadEvents() {
    setTableLoading(true);
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('*')
            .order('event_date', { ascending: false });

        if (error) throw error;

        allEvents = data || [];

        // REMOVE this block — don't overwrite the DB status locally
        // allEvents.forEach(ev => {
        //     ev.status = computeEventStatus(ev);
        // });

        updateBadges();
        renderTable(allEvents);
    } catch (err) {
        console.error('loadEvents error:', err);
        showTableError('Failed to load events: ' + (err.message || err));
    }
}

function updateBadges() {
    const total = allEvents.length;
    const upcoming = allEvents.filter(e => computeEventStatus(e) === 'upcoming').length;
    const past = allEvents.filter(e => {
        const s = computeEventStatus(e);
        return s === 'completed' || s === 'cancelled';
    }).length;
    setText('badgeTotal', total);
    setText('badgeUpcoming', upcoming);
    setText('badgePast', past);
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

const typeColors = {
    assembly: '#8b5cf6', meeting: '#06b6d4', sports: '#f59e0b',
    ceremony: '#ec4899', exam: '#ef4444', holiday: '#22c55e', other: '#6b7280',
};

const statusColors = {
    upcoming: { bg: '#e0f2fe', text: '#0369a1' },
    ongoing: { bg: '#dcfce7', text: '#166534' },
    completed: { bg: '#f1f5f9', text: '#475569' },
    cancelled: { bg: '#fee2e2', text: '#b91c1c' },
};

function renderTable(rows) {
    const tbody = document.getElementById('eventsTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="8" class="empty-cell">
                <i class="fa-solid fa-calendar-day" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
                No events found.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(ev => {
        const typeColor = typeColors[ev.event_type] || '#6b7280';
        const status = computeEventStatus(ev);
        const sc = statusColors[status] || statusColors.upcoming;

        const dateLabel = (() => {
            if (!ev.event_date) return '—';
            const start = new Date(ev.event_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            if (ev.end_date && ev.end_date !== ev.event_date) {
                const end = new Date(ev.end_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                return `${start} – ${end}`;
            }
            return start;
        })();

        const timeLabel = ev.time_start
            ? `${formatTime(ev.time_start)}${ev.time_end ? ' – ' + formatTime(ev.time_end) : ''}`
            : '—';

        return `
        <tr data-type="${escHtml(ev.event_type || '')}" data-status="${status}">
            <td><span class="primary-cell">${escHtml(ev.event_name || '')}</span></td>
            <td>${dateLabel}</td>
            <td>${timeLabel}</td>
            <td><span class="badge" style="background:${typeColor}20;color:${typeColor}">${escHtml(ev.event_type || '—')}</span></td>
            <td><span class="secondary-cell">${escHtml(ev.location || '—')}</span></td>
            <td><span class="badge info">${escHtml(ev.target_grade_level || 'All')}${ev.target_section ? ' – ' + escHtml(ev.target_section) : ''}</span></td>
            <td><span class="badge" style="background:${sc.bg};color:${sc.text}">${escHtml(status)}</span></td>
            <td>
                <div style="display:flex;gap:8px">
                    <button class="btn-edit" title="Edit event" onclick="editEvent('${ev.event_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button class="btn-delete" title="Delete event" onclick="deleteEvent('${ev.event_id}', '${escHtml(ev.event_name)}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function formatTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':');
    const d = new Date();
    d.setHours(+h, +m, 0, 0);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ══════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════

document.getElementById('eventForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    clearValidationError();
    hideOverlapWarning();

    const eventId = document.getElementById('eventId').value.trim();
    const eventName = document.getElementById('eventName').value.trim();
    const eventDate = document.getElementById('eventDate').value;
    const eventEndDate = document.getElementById('eventEndDate').value;
    const eventType = document.getElementById('eventType').value;
    const timeStart = document.getElementById('timeStart').value;
    const timeEnd = document.getElementById('timeEnd').value;
    const location = document.getElementById('location').value.trim();
    const description = document.getElementById('description').value.trim();
    const participantMode = document.getElementById('participantMode').value;
    const isEdit = eventId !== '';

    const isMultiDay = document.getElementById('isMultiDay').checked;

    // Run the same field-specific validation used for live feedback,
    // so Save is blocked with the exact same messages the user already saw.
    if (!validateLive()) {
        document.getElementById('liveValidationBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
    }

    // Participant selection isn't checked live (it's not one of the four
    // live-warning categories), but it still has to be set before saving.
    if (participantMode === 'grade' && selectedGrades.size === 0) {
        showSingleValidationError('targetGradeLevel', 'Please select at least one target grade level');
        return;
    }
    if (participantMode === 'individual' && selectedStudentIds.size === 0) {
        showSingleValidationError('selectedStudents', 'Please select at least one student participant');
        return;
    }

    const btn = this.querySelector('.btn-submit');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        const now = getManilaNow();
        const todayStr = now.toLocaleDateString('en-CA');
        const currentTime = now.toTimeString().slice(0, 5);
        let initialStatus = 'upcoming';

        if (eventDate < todayStr || (eventDate === todayStr && timeStart && currentTime >= timeStart)) {
            if (!eventEndDate || eventEndDate > todayStr || (eventEndDate === todayStr && timeEnd && currentTime < timeEnd)) {
                initialStatus = 'ongoing';
            } else {
                initialStatus = 'completed';
            }
        }

        const payload = {
            event_name: eventName,
            event_date: eventDate,
            end_date: isMultiDay ? eventEndDate : null,
            event_type: eventType,
            time_start: timeStart || null,
            time_end: timeEnd || null,
            location: location || null,
            status: initialStatus,
            description: description || null,
            target_grade_level: participantMode === 'grade' ? Array.from(selectedGrades).join(',') : null,
            target_section: participantMode === 'grade' ? (Array.from(selectedSections).join(',') || null) : null,
        };

        let savedEventId = eventId;
        let saveErr;

        if (isEdit) {
            const { error } = await supabaseClient.from('events').update(payload).eq('event_id', eventId);
            saveErr = error;
            savedEventId = eventId;
        } else {
            const { data, error } = await supabaseClient.from('events').insert(payload).select('event_id');
            saveErr = error;
            savedEventId = data && data[0] ? data[0].event_id : null;
        }

        if (saveErr) throw saveErr;

       if (savedEventId) {
    // ── 1. Always wipe old links on edit so we can re-sync cleanly ──
    if (isEdit) {
        await supabaseClient.from('event_participants').delete().eq('event_id', savedEventId);
    }

    let studentIdsToInsert = new Set();

    // ── 2. Individual mode: use the hand-picked set ──
    if (participantMode === 'individual') {
        studentIdsToInsert = new Set(selectedStudentIds);
    }
    // ── 3. Grade/Section mode: query all matching active students ──
    else if (participantMode === 'grade') {
        // Build the list of section_ids that match the selected grades + sections
   const matchingSectionIds = allSectionsData
    .filter(s => {
        const gradeMatch  = selectedGrades.size === 0  || selectedGrades.has(s.grade_level);
        const sectionMatch = selectedSections.size === 0 || selectedSections.has(s.section_name);
        return gradeMatch && sectionMatch;
    })
    .map(s => s.section_id)
    .filter(id => id);   // <-- strips any undefined / null


        if (matchingSectionIds.length > 0) {
            const { data: matchedStudents, error: studentErr } = await supabaseClient
                .from('students')
                .select('student_id')
                .in('section_id', matchingSectionIds)
                .eq('status', 'active');

            if (studentErr) throw studentErr;
            matchedStudents?.forEach(s => studentIdsToInsert.add(s.student_id));
        }
    }

    // ── 4. Bulk insert the participants ──
    if (studentIdsToInsert.size > 0) {
        const participants = Array.from(studentIdsToInsert).map(studentId => ({
            event_id: savedEventId,
            student_id: studentId,
            added_by: null   // ← swap to currentUserId if you track the creator
        }));

        const { error: pError } = await supabaseClient
            .from('event_participants')
            .insert(participants);

        if (pError) throw pError;
    }
}

        showToast(isEdit ? 'Event updated successfully!' : 'Event added successfully!');
        btn.disabled = false;
        btn.innerHTML = orig;
        closeModal();
        await loadEvents();
    } catch (err) {
        console.error('Save event error:', err);
        showValidationError(err.message || 'An error occurred. Please try again.');
        btn.disabled = false;
        btn.innerHTML = orig;
    }
});

async function deleteEvent(eventId, eventName) {
    const confirmed = confirm(`Delete event "${eventName}"?\n\nThis will also remove any associated event attendance records.`);
    if (!confirmed) return;

    try {
        await supabaseClient.from('event_attendance').delete().eq('event_id', eventId);
        await supabaseClient.from('event_participants').delete().eq('event_id', eventId);
        const { error } = await supabaseClient.from('events').delete().eq('event_id', eventId);
        if (error) throw error;

        showToast(`"${eventName}" deleted successfully.`);
        await loadEvents();
    } catch (err) {
        console.error('Delete event error:', err);
        alert('Error deleting event: ' + (err.message || err));
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    document.getElementById('eventForm').reset();
    document.getElementById('eventId').value = '';

    selectedGrades.clear();
    selectedSections.clear();
    const grades = [...new Set(allSectionsData.map(s => s.grade_level).filter(Boolean))];
    renderGradeOptions(grades);
    renderSectionOptions([]);
    
      // Clear live validation
    document.getElementById('liveValidationBox').style.display = 'none';
    document.getElementById('liveValidationList').innerHTML = '';
    document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
    document.getElementById('overlapWarning').classList.remove('active');
    
    document.getElementById('isMultiDay').checked = false;
    document.getElementById('eventEndDate').value = '';
    document.getElementById('eventEndDate').removeAttribute('required');
    document.getElementById('endDateRow').style.display = 'none';
    document.getElementById('participantMode').value = 'grade';
    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Add Event';
    document.getElementById('submitBtnText').textContent = 'Add Event';

    selectedStudentIds.clear();
    studentCache.clear();
    currentEventParticipants = [];
    toggleParticipantMode();
    hideOverlapWarning();
    clearAllValidation();

    loadGradeLevels();
    openModal();
}

async function editEvent(id) {
    const ev = allEvents.find(x => x.event_id === id);
    if (!ev) return;

    document.getElementById('eventId').value = ev.event_id;
    document.getElementById('eventName').value = ev.event_name || '';
    document.getElementById('eventDate').value = ev.event_date || '';
    document.getElementById('eventType').value = ev.event_type || '';
    document.getElementById('timeStart').value = ev.time_start || '';
    document.getElementById('timeEnd').value = ev.time_end || '';
    document.getElementById('location').value = ev.location || '';
    document.getElementById('description').value = ev.description || '';

    const hasEndDate = ev.end_date && ev.end_date !== ev.event_date;
    document.getElementById('isMultiDay').checked = hasEndDate;
    document.getElementById('eventEndDate').value = hasEndDate ? ev.end_date : '';
    toggleEndDate();

    await loadGradeLevels();

    selectedGrades.clear();
    if (ev.target_grade_level) {
        ev.target_grade_level.split(',').forEach(g => {
            const trimmed = g.trim();
            if (trimmed) selectedGrades.add(trimmed);
        });
    }
    const grades = [...new Set(allSectionsData.map(s => s.grade_level).filter(Boolean))];
    renderGradeOptions(grades);
    document.querySelectorAll('#gradeOptionsList .multi-select-option').forEach(opt => {
        if (selectedGrades.has(opt.dataset.value)) {
            opt.classList.add('selected');
            opt.querySelector('i').className = 'fa-solid fa-check-square';
        }
    });
    updateGradeTrigger();
    updateSectionOptions();

    selectedSections.clear();
    if (ev.target_section) {
        ev.target_section.split(',').forEach(s => {
            const trimmed = s.trim();
            if (trimmed) selectedSections.add(trimmed);
        });
    }
    document.querySelectorAll('#sectionOptionsList .multi-select-option').forEach(opt => {
        if (selectedSections.has(opt.dataset.value)) {
            opt.classList.add('selected');
            opt.querySelector('i').className = 'fa-solid fa-check-square';
        }
    });
    updateSectionTrigger();
    updateHiddenInput('targetGradeLevel', selectedGrades);
    updateHiddenInput('targetSection', selectedSections);

    await loadEventParticipants(ev.event_id);
    if (currentEventParticipants.length > 0) {
        document.getElementById('participantMode').value = 'individual';
        selectedStudentIds = new Set(currentEventParticipants.map(p => p.student_id));
        await preloadStudentNames(Array.from(selectedStudentIds));
    } else {
        document.getElementById('participantMode').value = 'grade';
        selectedStudentIds.clear();
    }
    toggleParticipantMode();

    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Event';
    document.getElementById('submitBtnText').textContent = 'Update Event';
    clearAllValidation();
    hideOverlapWarning();
    openModal();
}

function openModal() {
    document.getElementById('eventModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('eventModal').classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(clearAllValidation, 300);
}

// ══════════════════════════════════════════════════════════
// MULTI-SELECT DROPDOWNS
// ══════════════════════════════════════════════════════════

function renderGradeOptions(grades) {
    const container = document.getElementById('gradeOptionsList');
    if (!container) return;
    container.innerHTML = grades.map(g => `
        <div class="multi-select-option" data-value="${escHtml(g)}" onclick="toggleGrade('${escHtml(g)}', this)">
            <i class="fa-solid ${selectedGrades.has(g) ? 'fa-check-square' : 'fa-square'}"></i>
            <span>${escHtml(g)}</span>
        </div>
    `).join('');
    updateGradeTrigger();
}

function renderSectionOptions(sections) {
    const container = document.getElementById('sectionOptionsList');
    if (!container) return;
    if (sections.length === 0) {
        container.innerHTML = '<div class="multi-select-hint">Select grade(s) first to see sections</div>';
        return;
    }
    container.innerHTML = sections.map(s => `
        <div class="multi-select-option" data-value="${escHtml(s)}" onclick="toggleSection('${escHtml(s)}', this)">
            <i class="fa-solid ${selectedSections.has(s) ? 'fa-check-square' : 'fa-square'}"></i>
            <span>${escHtml(s)}</span>
        </div>
    `).join('');
    updateSectionTrigger();
}

function toggleDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains('open');

    document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.multi-select-trigger').forEach(t => t.classList.remove('active'));

    if (!isOpen) {
        dropdown.classList.add('open');
        if (dropdown.previousElementSibling) dropdown.previousElementSibling.classList.add('active');
    }
}

document.addEventListener('click', function (e) {
    if (!e.target.closest('.multi-select')) {
        document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('open'));
        document.querySelectorAll('.multi-select-trigger').forEach(t => t.classList.remove('active'));
    }
});

function toggleGrade(grade, el) {
    if (selectedGrades.has(grade)) {
        selectedGrades.delete(grade);
        el.classList.remove('selected');
        el.querySelector('i').className = 'fa-solid fa-square';
    } else {
        selectedGrades.add(grade);
        el.classList.add('selected');
        el.querySelector('i').className = 'fa-solid fa-check-square';
    }
    updateGradeTrigger();
    updateSectionOptions();
    updateHiddenInput('targetGradeLevel', selectedGrades);
}

function toggleAllGrades() {
    const options = document.querySelectorAll('#gradeOptionsList .multi-select-option');
    const allSelected = selectedGrades.size === options.length && options.length > 0;

    if (allSelected) {
        selectedGrades.clear();
        options.forEach(opt => {
            opt.classList.remove('selected');
            opt.querySelector('i').className = 'fa-solid fa-square';
        });
    } else {
        options.forEach(opt => {
            const grade = opt.dataset.value;
            selectedGrades.add(grade);
            opt.classList.add('selected');
            opt.querySelector('i').className = 'fa-solid fa-check-square';
        });
    }
    updateGradeTrigger();
    updateSectionOptions();
    updateHiddenInput('targetGradeLevel', selectedGrades);
}

function updateGradeTrigger() {
    const trigger = document.getElementById('gradeTriggerText');
    if (!trigger) return;
    const count = selectedGrades.size;
    if (count === 0) {
        trigger.textContent = '-- Select Grades --';
    } else if (count === 1) {
        trigger.textContent = Array.from(selectedGrades)[0];
    } else {
        trigger.innerHTML = `${count} grades selected <span class="count-badge">${count}</span>`;
    }
    const icon = document.getElementById('gradeAllIcon');
    if (icon) icon.className = count > 0 ? 'fa-solid fa-check-square' : 'fa-solid fa-square';
}

function toggleSection(section, el) {
    if (selectedSections.has(section)) {
        selectedSections.delete(section);
        el.classList.remove('selected');
        el.querySelector('i').className = 'fa-solid fa-square';
    } else {
        selectedSections.add(section);
        el.classList.add('selected');
        el.querySelector('i').className = 'fa-solid fa-check-square';
    }
    updateSectionTrigger();
    updateHiddenInput('targetSection', selectedSections);
}

function toggleAllSections() {
    const options = document.querySelectorAll('#sectionOptionsList .multi-select-option');
    const allSelected = selectedSections.size === options.length && options.length > 0;

    if (allSelected) {
        selectedSections.clear();
        options.forEach(opt => {
            opt.classList.remove('selected');
            opt.querySelector('i').className = 'fa-solid fa-square';
        });
    } else {
        options.forEach(opt => {
            const section = opt.dataset.value;
            selectedSections.add(section);
            opt.classList.add('selected');
            opt.querySelector('i').className = 'fa-solid fa-check-square';
        });
    }
    updateSectionTrigger();
    updateHiddenInput('targetSection', selectedSections);
}

function updateSectionTrigger() {
    const trigger = document.getElementById('sectionTriggerText');
    if (!trigger) return;
    const count = selectedSections.size;
    if (count === 0) {
        trigger.textContent = '-- All Sections --';
    } else if (count === 1) {
        trigger.textContent = Array.from(selectedSections)[0];
    } else {
        trigger.innerHTML = `${count} sections selected <span class="count-badge">${count}</span>`;
    }
    const icon = document.getElementById('sectionAllIcon');
    if (icon) icon.className = count > 0 ? 'fa-solid fa-check-square' : 'fa-solid fa-square';
}

function updateSectionOptions() {
    const availableSections = [...new Set(
        allSectionsData
            .filter(s => selectedGrades.size === 0 || selectedGrades.has(s.grade_level))
            .map(s => s.section_name)
            .filter(Boolean)
    )].sort();

    renderSectionOptions(availableSections);

    selectedSections.forEach(sec => {
        if (!availableSections.includes(sec)) selectedSections.delete(sec);
    });
    updateSectionTrigger();
    updateHiddenInput('targetSection', selectedSections);
}

function updateHiddenInput(id, set) {
    const input = document.getElementById(id);
    if (input) input.value = Array.from(set).join(',');
}

// ══════════════════════════════════════════════════════════
// PARTICIPANT MODE
// ══════════════════════════════════════════════════════════

function toggleParticipantMode() {
    const mode = document.getElementById('participantMode').value;
    const gradeRow = document.getElementById('gradeSectionTarget');
    const indSum = document.getElementById('individualParticipantsSummary');

    if (mode === 'grade') {
        if (gradeRow) gradeRow.style.display = '';
        if (indSum) indSum.style.display = 'none';
    } else {
        if (gradeRow) gradeRow.style.display = 'none';
        if (indSum) indSum.style.display = '';
        updateMainFormStudentSummary();
    }
}

// ══════════════════════════════════════════════════════════
// STUDENT SELECTION MODAL
// ══════════════════════════════════════════════════════════

function openStudentModal() {
    modalSelectedStudentIds = new Set(selectedStudentIds);
    const modal = document.getElementById('studentModal');
    if (modal) modal.classList.add('active');
    loadStudentsForModal();
}

function closeStudentModal() {
    const modal = document.getElementById('studentModal');
    if (modal) modal.classList.remove('active');
}

async function loadStudentsForModal() {
    const gradeFilter = document.getElementById('modalFilterGrade')?.value || '';
    const sectionFilter = document.getElementById('modalFilterSection')?.value || '';
    const search = document.getElementById('modalStudentSearch')?.value.toLowerCase() || '';
    const container = document.getElementById('modalStudentList');
    if (!container) return;

    container.innerHTML = '<div class="loading-students"><i class="fa-solid fa-spinner fa-spin"></i> Loading students...</div>';

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select('student_id, first_name, middle_name, last_name, stud_id, section_id, sections(grade_level, section_name)')
            .eq('status', 'active');

        if (error) {
            const fb = await supabaseClient
                .from('students')
                .select('student_id, first_name, middle_name, last_name, stud_id, section_id')
                .eq('status', 'active');
            if (fb.error) throw fb.error;
            modalAvailableStudents = (fb.data || []).map(s => ({ ...s, sections: null }));
        } else {
            modalAvailableStudents = data || [];
        }

        modalAvailableStudents.forEach(s => studentCache.set(s.student_id, s));

        if (gradeFilter) {
            modalAvailableStudents = modalAvailableStudents.filter(s =>
                s.sections?.grade_level === gradeFilter
            );
        }
        if (sectionFilter) {
            modalAvailableStudents = modalAvailableStudents.filter(s =>
                s.sections?.section_name === sectionFilter
            );
        }
        if (search) {
            modalAvailableStudents = modalAvailableStudents.filter(s => {
                const name = `${s.first_name} ${s.last_name}`.toLowerCase();
                const id = (s.stud_id || '').toLowerCase();
                return name.includes(search) || id.includes(search);
            });
        }

        renderModalStudentList();

    } catch (err) {
        console.error('loadStudentsForModal error:', err);
        if (container) container.innerHTML = '<div class="error-students">Failed to load students</div>';
    }
}

function renderModalStudentList() {
    const container = document.getElementById('modalStudentList');
    if (!container) return;
    if (modalAvailableStudents.length === 0) {
        container.innerHTML = '<div class="no-students">No students match your filters</div>';
        updateModalSelectionCount();
        return;
    }
    container.innerHTML = modalAvailableStudents.map(s => {
        const isSelected = modalSelectedStudentIds.has(s.student_id);
        const info = s.sections ? `(${s.sections.grade_level} ${s.sections.section_name || ''})` : '';
        return `
        <div class="student-item ${isSelected ? 'selected' : ''}" onclick="toggleModalStudentSelection('${s.student_id}')">
            <div class="student-checkbox">
                <i class="fa-solid ${isSelected ? 'fa-check-square' : 'fa-square'}"></i>
            </div>
            <div class="student-info">
                <div class="student-name">${escHtml(s.first_name)} ${escHtml(s.last_name)}</div>
                <div class="student-meta">${escHtml(s.stud_id)} ${escHtml(info)}</div>
            </div>
        </div>`;
    }).join('');
    updateModalSelectionCount();
}

function toggleModalStudentSelection(id) {
    if (modalSelectedStudentIds.has(id)) modalSelectedStudentIds.delete(id);
    else modalSelectedStudentIds.add(id);
    renderModalStudentList();
}

function selectAllVisibleStudents() {
    modalAvailableStudents.forEach(s => modalSelectedStudentIds.add(s.student_id));
    renderModalStudentList();
}

function clearAllVisibleSelections() {
    modalAvailableStudents.forEach(s => modalSelectedStudentIds.delete(s.student_id));
    renderModalStudentList();
}

function updateModalSelectionCount() {
    const n = modalSelectedStudentIds.size;
    const el = document.getElementById('modalSelectionCount');
    if (el) el.textContent = `${n} student${n !== 1 ? 's' : ''} selected`;
}

function confirmStudentSelection() {
    selectedStudentIds = new Set(modalSelectedStudentIds);
    updateMainFormStudentSummary();
    closeStudentModal();
}

function updateMainFormStudentSummary() {
    const box = document.getElementById('mainSelectedSummary');
    if (!box) return;
    const n = selectedStudentIds.size;
    if (n === 0) {
        box.innerHTML = '<span class="no-selection">No students selected. Click "Choose Students" to select.</span>';
        return;
    }
    const list = [];
    selectedStudentIds.forEach(id => {
        const s = studentCache.get(id);
        if (s) list.push(s);
    });
    if (list.length === 0) {
        box.innerHTML = `<span style="color:#374151;font-size:14px;">${n} student${n !== 1 ? 's' : ''} selected</span>`;
        return;
    }
    box.innerHTML = `
        <div class="selected-chips">
            ${list.map(s => `
                <span class="participant-chip">${escHtml(s.first_name)} ${escHtml(s.last_name)}</span>
            `).join('')}
            ${n > list.length ? `<span class="participant-chip" style="background:#9ca3af;">+${n - list.length} more</span>` : ''}
        </div>`;
}

async function addAllStudents() {
    const btn = document.querySelector('.btn-outline-success');
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select('student_id, first_name, middle_name, last_name, stud_id, sections(grade_level, section_name)')
            .eq('status', 'active');

        if (error) throw error;

        const students = data || [];
        selectedStudentIds = new Set(students.map(s => s.student_id));
        students.forEach(s => studentCache.set(s.student_id, s));

        updateMainFormStudentSummary();
        showToast(`${students.length} students added as participants`);

    } catch (err) {
        console.error('addAllStudents error:', err);
        showValidationError('Failed to load all students: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

async function preloadStudentNames(ids) {
    if (!ids || ids.length === 0) return;
    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select('student_id, first_name, middle_name, last_name, stud_id, sections(grade_level, section_name)')
            .in('student_id', ids);
        if (error) throw error;
        (data || []).forEach(s => studentCache.set(s.student_id, s));
        updateMainFormStudentSummary();
    } catch (err) {
        console.error('preloadStudentNames error:', err);
    }
}

async function loadEventParticipants(eventId) {
    try {
        const { data, error } = await supabaseClient
            .from('event_participants')
            .select('student_id')
            .eq('event_id', eventId);
        if (error) throw error;
        currentEventParticipants = data || [];
    } catch (err) {
        console.error('loadEventParticipants error:', err);
        currentEventParticipants = [];
    }
}

// ══════════════════════════════════════════════════════════
// OVERLAP DETECTION
// ══════════════════════════════════════════════════════════

function checkEventOverlap(eventDate, eventEndDate, timeStart, timeEnd, excludeEventId = null) {
    if (!eventDate || !timeStart || !timeEnd) return [];
    const ourEnd = eventEndDate || eventDate;

    return allEvents.filter(event => {
        if (excludeEventId && event.event_id === excludeEventId) return false;
        if (event.status === 'cancelled') return false;
        if (!event.time_start || !event.time_end) return false;

        const existingEnd = event.end_date || event.event_date;
        const dateOverlap = eventDate <= existingEnd && ourEnd >= event.event_date;
        const timeOverlap = timeStart < event.time_end && timeEnd > event.time_start;

        return dateOverlap && timeOverlap;
    });
}

function showOverlapWarning(overlappingEvents) {
    const warningDiv = document.getElementById('overlapWarning');
    const detailsDiv = document.getElementById('overlapDetails');
    if (!warningDiv || !detailsDiv) return false;

    if (!overlappingEvents || overlappingEvents.length === 0) {
        warningDiv.style.display = 'none';
        return false;
    }

    const eventsList = overlappingEvents.map(e => {
        const timeStr = e.time_start && e.time_end
            ? `${formatTime(e.time_start)} - ${formatTime(e.time_end)}`
            : 'All day';
        const loc = e.location ? ` at ${escHtml(e.location)}` : '';
        return `<strong>${escHtml(e.event_name)}</strong> (${timeStr}${loc})`;
    }).join('<br>');

    detailsDiv.innerHTML = eventsList;
    warningDiv.style.display = 'flex';
    return true;
}

function hideOverlapWarning() {
    const warningDiv = document.getElementById('overlapWarning');
    if (warningDiv) warningDiv.style.display = 'none';
    const confirmBox = document.getElementById('confirmOverlap');
    if (confirmBox) confirmBox.checked = false;
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function toggleEndDate() {
    const isChecked = document.getElementById('isMultiDay')?.checked;
    const endDateRow = document.getElementById('endDateRow');
    const endDateInput = document.getElementById('eventEndDate');
    if (!endDateRow || !endDateInput) return;

    if (isChecked) {
        endDateRow.style.display = 'flex';
        endDateInput.setAttribute('required', 'required');
    } else {
        endDateRow.style.display = 'none';
        endDateInput.value = '';
        endDateInput.removeAttribute('required');
    }
}

function applyFilters() {
    const q = document.getElementById('searchInput')?.value.toLowerCase() || '';
    const type = document.getElementById('typeFilter')?.value || '';
    const status = document.getElementById('statusFilter')?.value || '';

    document.querySelectorAll('#eventsTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch = row.textContent.toLowerCase().includes(q);
        const typeMatch = !type || row.dataset.type === type;
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && typeMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput')?.addEventListener('input', applyFilters);
    document.getElementById('typeFilter')?.addEventListener('change', applyFilters);
    document.getElementById('statusFilter')?.addEventListener('change', applyFilters);

    document.getElementById('clearFilters')?.addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('typeFilter').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
    });

    document.getElementById('eventModal')?.addEventListener('click', function (e) {
        if (e.target === this) closeModal();
    });

    document.getElementById('studentModal')?.addEventListener('click', function (e) {
        if (e.target === this) closeStudentModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const studentModal = document.getElementById('studentModal');
            if (studentModal && studentModal.classList.contains('active')) {
                closeStudentModal();
                return;
            }
            closeModal();
        }
    });
}

function setTableLoading(on) {
    const tbody = document.getElementById('eventsTableBody');
    if (tbody && on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="8" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading events…</td></tr>`;
}

function showTableError(msg) {
    const tbody = document.getElementById('eventsTableBody');
    if (tbody) tbody.innerHTML = `
        <tr><td colspan="8" class="empty-cell" style="color:#dc2626">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:36px;display:block;margin-bottom:10px"></i>
            ${escHtml(msg)}
        </td></tr>`;
}

function showValidationError(message) {
    clearValidationError();
    const div = document.createElement('div');
    div.className = 'validation-error';
    div.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i><span>${escHtml(message)}</span>`;
    const form = document.getElementById('eventForm');
    if (form && form.parentElement) {
        form.parentElement.insertBefore(div, form);
        div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => div.remove(), 6000);
    }
}

function clearValidationError() {
    document.querySelectorAll('.validation-error').forEach(el => el.remove());
}

function clearAllValidation() {
    clearValidationError();
    document.querySelectorAll('#eventModal input, #eventModal select, #eventModal textarea').forEach(el => { el.style.borderColor = ''; });
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.className = 'toast on' + (isError ? ' error' : '');
    setTimeout(() => toast.className = 'toast', 4000);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ══════════════════════════════════════════════════════════
// LIVE VALIDATION
// ══════════════════════════════════════════════════════════

function showSingleValidationError(fieldId, msg) {
    document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));

    const liveBox = document.getElementById('liveValidationBox');
    const liveList = document.getElementById('liveValidationList');
    liveBox.style.display = 'block';
    liveList.innerHTML = `<li>${escHtml(msg)}</li>`;

    const field = document.getElementById(fieldId);
    if (field) field.classList.add('input-error');
    const errorSpan = document.getElementById('error-' + fieldId);
    if (errorSpan) errorSpan.textContent = msg;

    liveBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function validateLive() {
    document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));

    const eventId = document.getElementById('eventId').value;
    const eventName = document.getElementById('eventName').value.trim();
    const eventDate = document.getElementById('eventDate').value;
    const isMultiDay = document.getElementById('isMultiDay').checked;
    const eventEndDate = document.getElementById('eventEndDate').value;
    const timeStart = document.getElementById('timeStart').value;
    const timeEnd = document.getElementById('timeEnd').value;

    const todayStr = getManilaNow().toLocaleDateString('en-CA');
    let error = null; // only ever show ONE message at a time

    // 1) Date validity — start date in the past, end date in the past, or end before start
    if (eventDate && eventDate < todayStr) {
        error = { field: 'eventDate', msg: 'Event date cannot be set in the past' };
    } else if (isMultiDay && eventEndDate) {
        if (eventEndDate < todayStr) {
            error = { field: 'eventEndDate', msg: 'End date cannot be set in the past' };
        } else if (eventEndDate < eventDate) {
            error = { field: 'eventEndDate', msg: 'End date must be on or after the start date' };
        }
    }

    // 2) Time validity
    if (!error) {
        if (timeStart && !timeEnd) {
            error = { field: 'timeEnd', msg: 'End time is required when a start time is set' };
        } else if (!timeStart && timeEnd) {
            error = { field: 'timeStart', msg: 'Start time is required when an end time is set' };
        } else if (timeStart && timeEnd && timeEnd <= timeStart) {
            error = { field: 'timeEnd', msg: 'End time must be after the start time' };
        } else if (timeStart && eventDate === todayStr) {
            const nowTime = getManilaNow().toTimeString().slice(0, 5);
            if (timeStart < nowTime) {
                error = { field: 'timeStart', msg: 'Start time cannot be in the past for a same-day event' };
            }
        }
    }

    // 3) Duplicate event — same name landing on the same date
    if (!error && eventName && eventDate) {
        const isDuplicate = allEvents.some(ev =>
            ev.event_id !== eventId &&
            (ev.event_name || '').trim().toLowerCase() === eventName.toLowerCase() &&
            (ev.event_date === eventDate || (ev.end_date && eventDate >= ev.event_date && eventDate <= ev.end_date))
        );
        if (isDuplicate) {
            error = { field: 'eventName', msg: `An event named "${eventName}" is already scheduled on this date` };
        }
    }

    // 4) Overlapping schedule
    const warningDiv = document.getElementById('overlapWarning');
    let hasOverlap = false;
    if (eventDate && timeStart && timeEnd && timeEnd > timeStart) {
        const overlapping = checkEventOverlap(eventDate, eventEndDate, timeStart, timeEnd, eventId);
        if (overlapping.length > 0) {
            hasOverlap = true;
            const detailsDiv = document.getElementById('overlapDetails');
            const eventsList = overlapping.map(ev => {
                const timeStr = ev.time_start && ev.time_end
                    ? `${formatTime(ev.time_start)} - ${formatTime(ev.time_end)}`
                    : 'All day';
                const loc = ev.location ? ` at ${escHtml(ev.location)}` : '';
                return `<strong>${escHtml(ev.event_name)}</strong> (${timeStr}${loc})`;
            }).join('<br>');
            detailsDiv.innerHTML = eventsList;
            warningDiv.classList.add('active');

            if (!error) {
                const confirmBox = document.getElementById('confirmOverlap');
                if (!confirmBox.checked) {
                    const namesWithTimes = overlapping.map(ev => {
                        const timeStr = ev.time_start && ev.time_end
                            ? `${formatTime(ev.time_start)}–${formatTime(ev.time_end)}`
                            : 'all day';
                        return `"${ev.event_name}" (${timeStr})`;
                    }).join(', ');
                    error = { field: 'overlap', msg: `This time slot overlaps with ${namesWithTimes}` };
                }
            }
        }
    }
    if (!hasOverlap) warningDiv.classList.remove('active');

    // Display — exactly one message, or none
    const liveBox = document.getElementById('liveValidationBox');
    const liveList = document.getElementById('liveValidationList');

    if (error) {
        liveBox.style.display = 'block';
        liveList.innerHTML = `<li>${escHtml(error.msg)}</li>`;

        const field = document.getElementById(error.field);
        if (field) field.classList.add('input-error');
        const errorSpan = document.getElementById('error-' + error.field);
        if (errorSpan) errorSpan.textContent = error.msg;

        return false;
    } else {
        liveBox.style.display = 'none';
        liveList.innerHTML = '';
        return true;
    }
}

// Clear validation on input
function clearFieldError(fieldId) {
    const field = document.getElementById(fieldId);
    if (field) field.classList.remove('input-error');
    const errorSpan = document.getElementById('error-' + fieldId);
    if (errorSpan) errorSpan.textContent = '';
}