/* ═══════════════════════════════════════════════════════════
   events.js — Events Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / events.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allEvents = [];
const todayISO = new Date().toLocaleDateString('en-CA');

// Multi-select globals
let selectedGrades = new Set();
// A null value means All Sections; otherwise the Set holds section UUIDs.
let gradeSectionTargets = new Map();
let allSectionsData = [];
let applicableSchoolYear = null;
let editingTargetKind = 'new';
let initialLegacyTarget = '';
let previewSequence = 0;

// Student modal globals
let modalSelectedStudentIds = new Set();
let modalAvailableStudents = [];
const studentCache = new Map();
let selectedStudentIds = new Set();
let currentEventParticipants = [];

let activeTimeInput = null;
let activeTimeTrigger = null;
let pickerHour = 12;
let pickerMinute = 0;
let pickerPeriod = 'AM';
let pickerMode = 'hour';
let activeDateInput = null;
let activeDateTrigger = null;
let calendarYear;
let calendarMonth;
let pendingCalendarDate = '';

document.addEventListener('DOMContentLoaded', () => {
    bindTimePicker();
    bindDatePicker();
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    loadGradeLevels();
    loadEvents();
    bindEvents();

    // Refresh the displayed status at second precision so transitions are immediate.
    setInterval(() => {
        if (allEvents.length > 0) {
            updateEventStatusesLocal();
        }
    }, 1000);
});

function bindTimePicker() {
    const overlay = document.getElementById('eventTimePicker');
    if (!overlay) {
        console.error('Event time picker markup is missing.');
        return;
    }

    document.querySelectorAll('.time-picker-trigger').forEach(trigger => {
        trigger.addEventListener('click', () => openTimePicker(trigger));
        const input = document.getElementById(trigger.dataset.timePicker);
        if (input instanceof HTMLInputElement) {
            updateTimePickerTrigger(input);
            input.addEventListener('input', () => updateTimePickerTrigger(input));
            input.addEventListener('change', () => updateTimePickerTrigger(input));
        }
    });

    const hourInput = document.getElementById('timePickerHour');
    const minuteInput = document.getElementById('timePickerMinute');
    hourInput.addEventListener('input', () => {
        const value = Number(hourInput.value);
        if (hourInput.value !== '' && value >= 1 && value <= 12) {
            pickerHour = value;
            renderTimePickerDial();
        }
    });
    minuteInput.addEventListener('input', () => {
        const value = Number(minuteInput.value);
        if (minuteInput.value !== '' && value >= 0 && value <= 59) {
            pickerMinute = value;
            renderTimePickerDial();
        }
    });

    overlay.querySelectorAll('[data-period]').forEach(button => {
        button.addEventListener('click', () => {
            pickerPeriod = button.dataset.period;
            updateTimePickerDisplay();
        });
    });
    overlay.querySelectorAll('[data-time-mode]').forEach(button => {
        button.addEventListener('click', () => {
            pickerMode = button.dataset.timeMode;
            updateTimePickerDisplay();
            renderTimePickerDial();
        });
    });
    overlay.querySelector('.time-picker-close').addEventListener('click', closeTimePicker);
    overlay.querySelector('.time-picker-cancel').addEventListener('click', closeTimePicker);
    overlay.querySelector('.time-picker-clear').addEventListener('click', clearTimePicker);
    overlay.querySelector('.time-picker-confirm').addEventListener('click', confirmTimePicker);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeTimePicker();
    });
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeTimePicker();
        } else if (event.key === 'Tab') {
            const focusable = Array.from(overlay.querySelectorAll(
                'button:not([disabled]), input:not([disabled])'
            ));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
}

function openTimePicker(trigger) {
    const input = document.getElementById(trigger.dataset.timePicker);
    const overlay = document.getElementById('eventTimePicker');
    if (!(input instanceof HTMLInputElement) || !overlay) {
        console.error('Unable to open time picker: time input or dialog is missing.');
        return;
    }

    activeTimeInput = input;
    activeTimeTrigger = trigger;
    updateTimePickerTrigger(input);
    const [hours, minutes] = input.value ? input.value.split(':').map(Number) : [0, 0];
    pickerHour = input.value ? (hours % 12 || 12) : 12;
    pickerMinute = input.value ? minutes : 0;
    pickerPeriod = input.value && hours >= 12 ? 'PM' : 'AM';
    pickerMode = 'hour';

    document.getElementById('timePickerTitle').textContent =
        input.id === 'timeStart' ? 'Choose start time' : 'Choose end time';
    document.getElementById('timePickerHour').value = String(pickerHour).padStart(2, '0');
    document.getElementById('timePickerMinute').value = String(pickerMinute).padStart(2, '0');
    trigger.classList.add('is-open');
    overlay.hidden = false;
    updateTimePickerDisplay();
    renderTimePickerDial();
    document.getElementById('timePickerHour').focus();
}

function updateTimePickerDisplay() {
    const overlay = document.getElementById('eventTimePicker');
    overlay.querySelectorAll('[data-period]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.period === pickerPeriod));
    });
    overlay.querySelectorAll('[data-time-mode]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.timeMode === pickerMode));
    });
    document.getElementById('timePickerHour').classList.toggle('is-active', pickerMode === 'hour');
    document.getElementById('timePickerMinute').classList.toggle('is-active', pickerMode === 'minute');
}

function renderTimePickerDial() {
    const dial = document.getElementById('timePickerDial');
    if (!dial) return;
    dial.setAttribute('aria-label', pickerMode === 'hour' ? 'Choose hour' : 'Choose minute');
    const center = dial.clientWidth / 2;
    const selectedValue = pickerMode === 'hour'
        ? pickerHour
        : Math.round(pickerMinute / 5) % 12;
    const options = Array.from({ length: 12 }, (_, index) => {
        const angle = index * (Math.PI / 6);
        const radius = center - 26;
        const x = center + Math.sin(angle) * radius;
        const y = center - Math.cos(angle) * radius;
        const value = pickerMode === 'hour' ? (index === 0 ? 12 : index) : index * 5;
        const label = pickerMode === 'hour' ? String(value) : String(value).padStart(2, '0');
        const isSelected = pickerMode === 'hour' ? value === selectedValue : index === selectedValue;
        return `<button type="button" class="time-picker-dial-option" style="left:${x}px;top:${y}px"
                    aria-label="${pickerMode === 'hour' ? `Hour ${label}` : `Minute ${label}`}"
                    aria-pressed="${isSelected}" data-clock-value="${value}">${label}</button>`;
    });
    dial.innerHTML = options.join('');
    dial.querySelectorAll('[data-clock-value]').forEach(button => {
        button.addEventListener('click', () => {
            const value = Number(button.dataset.clockValue);
            if (pickerMode === 'hour') {
                pickerHour = value;
                document.getElementById('timePickerHour').value = String(value).padStart(2, '0');
                pickerMode = 'minute';
                updateTimePickerDisplay();
                renderTimePickerDial();
            } else {
                pickerMinute = value;
                document.getElementById('timePickerMinute').value = String(value).padStart(2, '0');
                renderTimePickerDial();
            }
        });
    });
}

function updateTimePickerTrigger(input) {
    const trigger = document.querySelector(`[data-time-picker="${input.id}"]`);
    if (!trigger) return;
    const value = trigger.querySelector('.time-picker-value');
    const isEmpty = !input.value;
    trigger.classList.toggle('is-empty', isEmpty);
    value.textContent = isEmpty ? 'Choose time' : formatPickerTime(input.value);
    const timeLabel = input.id === 'timeStart' ? 'start time' : 'end time';
    trigger.setAttribute('aria-label', isEmpty
        ? `Choose ${timeLabel}`
        : `Change ${timeLabel}, currently ${formatPickerTime(input.value)}`);
}

function formatPickerTime(value) {
    const [hours, minutes] = value.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    return `${String(hours % 12 || 12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
}

function confirmTimePicker() {
    const hourInput = document.getElementById('timePickerHour');
    const minuteInput = document.getElementById('timePickerMinute');
    if (!hourInput.reportValidity()) return;
    if (!minuteInput.reportValidity()) return;
    if (!activeTimeInput) {
        console.error('Unable to apply selected time: no active time input.');
        closeTimePicker();
        return;
    }

    const hour12 = Number(hourInput.value) % 12;
    const hour24 = hour12 + (pickerPeriod === 'PM' ? 12 : 0);
    activeTimeInput.value = `${String(hour24).padStart(2, '0')}:${String(Number(minuteInput.value)).padStart(2, '0')}`;
    activeTimeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeTimeInput.dispatchEvent(new Event('change', { bubbles: true }));
    updateTimePickerTrigger(activeTimeInput);
    closeTimePicker();
}

function clearTimePicker() {
    if (!activeTimeInput) return;
    activeTimeInput.value = '';
    activeTimeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeTimeInput.dispatchEvent(new Event('change', { bubbles: true }));
    updateTimePickerTrigger(activeTimeInput);
    closeTimePicker();
}

function closeTimePicker() {
    const overlay = document.getElementById('eventTimePicker');
    if (overlay) overlay.hidden = true;
    if (activeTimeTrigger) {
        activeTimeTrigger.classList.remove('is-open');
        activeTimeTrigger.focus();
    }
    activeTimeInput = null;
    activeTimeTrigger = null;
}

function bindDatePicker() {
    const overlay = document.getElementById('eventDatePicker');
    if (!overlay) {
        console.error('Event date picker markup is missing.');
        return;
    }

    document.querySelectorAll('.date-picker-trigger').forEach(trigger => {
        trigger.addEventListener('click', () => openDatePicker(trigger));
        const input = document.getElementById(trigger.dataset.datePicker);
        if (input instanceof HTMLInputElement) {
            updateDatePickerTrigger(input);
            input.addEventListener('input', () => updateDatePickerTrigger(input));
            input.addEventListener('change', () => updateDatePickerTrigger(input));
        }
    });

    overlay.querySelectorAll('[data-month-step]').forEach(button => {
        button.addEventListener('click', () => {
            closeDateMonthJump();
            calendarMonth += Number(button.dataset.monthStep);
            if (calendarMonth < 0) {
                calendarMonth = 11;
                calendarYear -= 1;
            } else if (calendarMonth > 11) {
                calendarMonth = 0;
                calendarYear += 1;
            }
            renderDatePickerCalendar();
        });
    });
    overlay.querySelector('.date-picker-month-label').addEventListener('click', toggleDateMonthJump);
    overlay.querySelector('.date-picker-jump-apply').addEventListener('click', applyDateMonthJump);
    document.getElementById('datePickerYearInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyDateMonthJump();
        }
    });
    overlay.querySelector('.date-picker-close').addEventListener('click', closeDatePicker);
    overlay.querySelector('.date-picker-cancel').addEventListener('click', closeDatePicker);
    overlay.querySelector('.date-picker-clear').addEventListener('click', clearDatePicker);
    overlay.querySelector('.date-picker-today').addEventListener('click', () => {
        const today = getManilaNow();
        pendingCalendarDate = getLocalDateISO(today);
        calendarYear = today.getFullYear();
        calendarMonth = today.getMonth();
        closeDateMonthJump();
        renderDatePickerCalendar();
    });
    overlay.querySelector('.date-picker-confirm').addEventListener('click', confirmDatePicker);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeDatePicker();
    });
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeDatePicker();
        } else if (event.key === 'Tab') {
            const focusable = Array.from(overlay.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), select:not([disabled])'
            )).filter(element => !element.closest('[hidden]'));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
}

function openDatePicker(trigger) {
    const input = document.getElementById(trigger.dataset.datePicker);
    const overlay = document.getElementById('eventDatePicker');
    if (!(input instanceof HTMLInputElement) || !overlay) {
        console.error('Unable to open date picker: date input or dialog is missing.');
        return;
    }

    activeDateInput = input;
    activeDateTrigger = trigger;
    pendingCalendarDate = input.value;
    const initialDate = input.value ? parseLocalDate(input.value) : getManilaNow();
    calendarYear = initialDate.getFullYear();
    calendarMonth = initialDate.getMonth();
    document.getElementById('datePickerTitle').textContent =
        input.id === 'eventDate' ? 'Choose event date' : 'Choose end date';
    trigger.classList.add('is-open');
    overlay.hidden = false;
    renderDatePickerCalendar();
    overlay.querySelector('.date-picker-confirm').focus();
}

function renderDatePickerCalendar() {
    const calendar = document.getElementById('datePickerCalendar');
    const monthLabel = document.getElementById('datePickerMonthLabel');
    if (!calendar || !monthLabel) return;

    const firstWeekday = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const todayISO = getLocalDateISO(getManilaNow());
    const displayMonth = new Date(calendarYear, calendarMonth, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    monthLabel.querySelector('span').textContent = displayMonth;
    document.getElementById('datePickerMonthSelect').value = String(calendarMonth);
    document.getElementById('datePickerYearInput').value = String(calendarYear);

    const cells = [];
    for (let index = 0; index < firstWeekday; index += 1) {
        cells.push('<span class="date-picker-empty" aria-hidden="true"></span>');
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
        const dateValue = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isSelected = dateValue === pendingCalendarDate;
        const isToday = dateValue === todayISO;
        const classes = [
            'date-picker-day',
            isSelected ? 'is-selected' : '',
            isToday ? 'is-today' : '',
        ].filter(Boolean).join(' ');
        cells.push(`<button type="button" class="${classes}" data-calendar-date="${dateValue}"
            aria-label="${new Date(calendarYear, calendarMonth, day).toLocaleDateString('en-US', { dateStyle: 'full' })}"
            aria-pressed="${isSelected}">${day}</button>`);
    }
    calendar.innerHTML = cells.join('');
    calendar.querySelectorAll('[data-calendar-date]').forEach(button => {
        button.addEventListener('click', () => {
            pendingCalendarDate = button.dataset.calendarDate;
            renderDatePickerCalendar();
            calendar.querySelector(`[data-calendar-date="${pendingCalendarDate}"]`)?.focus();
        });
    });
}

function toggleDateMonthJump() {
    const panel = document.getElementById('datePickerMonthJump');
    const toggle = document.getElementById('datePickerMonthLabel');
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
        document.getElementById('datePickerYearInput').focus();
        document.getElementById('datePickerYearInput').select();
    }
}

function closeDateMonthJump() {
    const panel = document.getElementById('datePickerMonthJump');
    const toggle = document.getElementById('datePickerMonthLabel');
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
}

function applyDateMonthJump() {
    const yearInput = document.getElementById('datePickerYearInput');
    const monthSelect = document.getElementById('datePickerMonthSelect');
    if (!yearInput.reportValidity()) return;

    calendarYear = Number(yearInput.value);
    calendarMonth = Number(monthSelect.value);
    closeDateMonthJump();
    renderDatePickerCalendar();
    document.getElementById('datePickerMonthLabel').focus();
}

function getLocalDateISO(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
}

function updateDatePickerTrigger(input) {
    const trigger = document.querySelector(`[data-date-picker="${input.id}"]`);
    if (!trigger) return;
    const value = trigger.querySelector('.date-picker-value');
    const isEmpty = !input.value;
    const dateLabel = input.id === 'eventDate' ? 'event date' : 'end date';
    trigger.classList.toggle('is-empty', isEmpty);
    value.textContent = isEmpty
        ? 'Choose date'
        : parseLocalDate(input.value).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    trigger.setAttribute('aria-label', isEmpty
        ? `Choose ${dateLabel}`
        : `Change ${dateLabel}, currently ${value.textContent}`);
}

function confirmDatePicker() {
    if (!activeDateInput || !pendingCalendarDate) return;
    activeDateInput.value = pendingCalendarDate;
    activeDateInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeDateInput.dispatchEvent(new Event('change', { bubbles: true }));
    updateDatePickerTrigger(activeDateInput);
    closeDatePicker();
}

function clearDatePicker() {
    if (!activeDateInput) return;
    activeDateInput.value = '';
    activeDateInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeDateInput.dispatchEvent(new Event('change', { bubbles: true }));
    updateDatePickerTrigger(activeDateInput);
    closeDatePicker();
}

function closeDatePicker() {
    const overlay = document.getElementById('eventDatePicker');
    if (overlay) overlay.hidden = true;
    closeDateMonthJump();
    if (activeDateTrigger) {
        activeDateTrigger.classList.remove('is-open');
        activeDateTrigger.focus();
    }
    activeDateInput = null;
    activeDateTrigger = null;
    pendingCalendarDate = '';
}

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
    const currentTime = now.toTimeString().slice(0, 8); // "HH:MM:SS"

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

    // Update the local state immediately; database writes happen in parallel.
    updates.forEach(upd => {
        const ev = allEvents.find(e => e.event_id === upd.event_id);
        if (ev) ev.status = upd.status;
    });
    updateBadges();
    renderTable(allEvents);

    await Promise.all(updates.map(async upd => {
        try {
            const { error } = await supabaseClient
                .from('events')
                .update({ status: upd.status, updated_at: new Date().toISOString() })
                .eq('event_id', upd.event_id);
            if (error) throw error;
        } catch (err) {
            console.error('Status sync failed for', upd.event_id, err);
        }
    }));
}

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════

async function loadGradeLevels(schoolYearId = null) {
    try {
        const yearResult = await supabaseClient.from('school_years')
            .select('id, name, is_active')
            .eq(schoolYearId ? 'id' : 'is_active', schoolYearId || true)
            .limit(1);
        if (yearResult.error) throw yearResult.error;
        applicableSchoolYear = yearResult.data?.[0] || null;
        if (!applicableSchoolYear) throw new Error('No applicable school year was found.');
        document.getElementById('targetSchoolYearHint').textContent =
            `Target school year: ${applicableSchoolYear.name || 'Current school year'}`;
        const { data, error } = await supabaseClient.from('sections')
            .select('section_id, grade_level, section_name, school_year_id')
            .eq('school_year_id', applicableSchoolYear.id)
            .order('grade_level');
        if (error) throw error;
        allSectionsData = data || [];
        const grades = ['Kinder', ...Array.from({ length: 10 }, (_, i) => `Grade ${i + 1}`)];
        renderGradeOptions(grades);
        renderGradeSectionGroups();
        const modalFilter = document.getElementById('modalFilterGrade');
        if (modalFilter) {
            modalFilter.innerHTML = '<option value="">All Grades</option>';
            grades.forEach(g => modalFilter.add(new Option(g, g)));
        }

    } catch (err) {
        console.error('loadGradeLevels error:', err);
        applicableSchoolYear = null;
        allSectionsData = [];
        document.getElementById('targetSchoolYearHint').textContent = 'School year unavailable';
        renderGradeOptions(['Kinder', ...Array.from({ length: 10 }, (_, i) => `Grade ${i + 1}`)]);
        renderGradeSectionGroups();
        document.getElementById('participantPreview').textContent = 'School year or sections could not be loaded; saving is unavailable.';
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
        await EventTargets.attach(supabaseClient, allEvents);

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
    assembly: '#0369a1', meeting: '#06b6d4', sports: '#f59e0b',
    ceremony: '#ec4899', exam: '#ef4444', holiday: '#22c55e', other: '#6b7280',
};

const statusColors = {
    upcoming: { bg: '#e0f2fe', text: '#0369a1' },
    ongoing: { bg: '#fff1c6', text: '#92400e' },
    completed: { bg: '#dcfce7', text: '#166534' },
    cancelled: { bg: '#fee2e2', text: '#b91c1c' },
};

function renderTable(rows) {
    const tbody = document.getElementById('eventsTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="7" class="empty-cell">
                <i class="fa-solid fa-calendar-day" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
                No events found.
            </td></tr>`;
        return;
    }

    // Derive badges from the full loaded list, including events hidden by filters.
    const locationConflictIds = EventScheduleConflicts.locationConflictIds(allEvents);
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
            <td>
                <span class="primary-cell">${escHtml(ev.event_name || '')}</span>
                ${locationConflictIds.has(ev.event_id) ? '<span class="location-conflict-badge" title="Another event uses this location during an overlapping time"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Location Conflict</span>' : ''}
            </td>
            <td>${dateLabel}</td>
            <td>${timeLabel}</td>
            <td><span class="badge" style="background:${typeColor}20;color:${typeColor}">${escHtml(ev.event_type || '—')}</span></td>
            <td><span class="secondary-cell">${escHtml(ev.location || '—')}</span></td>
            <td><span class="badge" style="background:${sc.bg};color:${sc.text}">${escHtml(status)}</span></td>
            <td>
                <div class="event-row-actions">
                    <button type="button" class="btn-view" aria-label="View ${escHtml(ev.event_name || 'event')}" title="View event" onclick="viewEvent('${ev.event_id}')">
                        <i class="fa-solid fa-eye" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="btn-edit" aria-label="Edit ${escHtml(ev.event_name || 'event')}" title="Edit event" onclick="editEvent('${ev.event_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button type="button" class="btn-delete" aria-label="Delete ${escHtml(ev.event_name || 'event')}" title="Delete event" onclick="deleteEvent('${ev.event_id}', '${escHtml(ev.event_name)}')">
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

async function viewEvent(id) {
    const ev = allEvents.find(event => event.event_id === id);
    const modal = document.getElementById('eventViewModal');
    if (!ev || !modal) {
        console.error('Unable to view event: event record or details dialog is missing.');
        return;
    }

    const status = computeEventStatus(ev);
    const colors = statusColors[status] || statusColors.upcoming;
    const formatDate = value => value
        ? new Date(value + 'T00:00:00').toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric',
        })
        : '—';
    const dateLabel = ev.end_date && ev.end_date !== ev.event_date
        ? `${formatDate(ev.event_date)} – ${formatDate(ev.end_date)}`
        : formatDate(ev.event_date);
    const timeLabel = ev.time_start
        ? `${formatTime(ev.time_start)}${ev.time_end ? ` – ${formatTime(ev.time_end)}` : ''}`
        : 'All day';
    const targetLabel = EventTargets.summary(ev);

    setText('eventViewTitle', ev.event_name || 'Event details');
    setText('eventViewName', ev.event_name || '—');
    setText('eventViewType', ev.event_type || '—');
    setText('eventViewDate', dateLabel);
    setText('eventViewTime', timeLabel);
    setText('eventViewLocation', ev.location || '—');
    setText('eventViewDescription', ev.description || 'No description provided.');
    document.getElementById('eventViewStatus').innerHTML =
        `<span class="badge" style="background:${colors.bg};color:${colors.text}">${escHtml(status)}</span>`;
    setText('eventViewTarget', targetLabel);

    const studentList = document.getElementById('eventViewStudentList');
    modal.dataset.eventId = id;
    const isIndividualTarget = !ev.targetSummaryUnavailable
        && Array.isArray(ev.normalizedTargets)
        && ev.normalizedTargets.length === 0
        && !ev.target_grade_level;
    studentList.innerHTML = isIndividualTarget
        ? '<p class="event-view-loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading selected students…</p>'
        : '';
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    modal.querySelector('.close-modal').focus();

    if (!isIndividualTarget) return;

    try {
        const participantRows = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await supabaseClient.from('event_participants')
                .select('student_id, students(student_id, stud_id, first_name, middle_name, last_name)')
                .eq('event_id', id)
                .order('student_id', { ascending: true })
                .range(offset, offset + pageSize - 1);
            if (error) throw error;
            const page = data || [];
            participantRows.push(...page);
            if (page.length < pageSize) break;
        }

        if (modal.dataset.eventId !== id || !modal.classList.contains('active')) return;
        if (participantRows.length === 0) {
            studentList.innerHTML = '<p class="event-view-empty">No individually selected students are linked to this event.</p>';
            return;
        }

        const names = participantRows.map(row => {
            const student = row.students;
            if (!student) return `Student record unavailable (${row.student_id})`;
            const fullName = [student.first_name, student.middle_name, student.last_name]
                .filter(Boolean).join(' ');
            return `${fullName || 'Unnamed student'}${student.stud_id ? ` (${student.stud_id})` : ''}`;
        });
        studentList.innerHTML = `<p class="event-view-target-label">Selected students (${names.length})</p>
            <ul>${names.map(name => `<li>${escHtml(name)}</li>`).join('')}</ul>`;
    } catch (error) {
        console.error('Unable to load event participants for viewing:', error);
        if (modal.dataset.eventId === id && modal.classList.contains('active')) {
            studentList.innerHTML = '<p class="event-view-error" role="alert">Selected student details could not be loaded. Please try again later.</p>';
        }
    }
}

function closeEventView() {
    const modal = document.getElementById('eventViewModal');
    if (modal) {
        modal.classList.remove('active');
        delete modal.dataset.eventId;
    }
    document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════

document.getElementById('eventForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    clearValidationError();

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
    if (isEdit && editingTargetKind === 'normalized' && participantMode !== 'grade') {
        UIFeedback.error('Changing a normalized Event to Individual mode requires a separate conversion review.');
        return;
    }
    if (isEdit && editingTargetKind === 'legacy-grade' &&
        (participantMode !== 'grade' || [...selectedGrades].sort().join(',') !== initialLegacyTarget)) {
        UIFeedback.error('Legacy Event targeting cannot be converted here. Review its existing roster and section names first.');
        return;
    }
    if (isEdit && editingTargetKind === 'individual' && participantMode !== 'individual') {
        UIFeedback.error('Changing an Individual Event to grade targeting requires a separate conversion review.');
        return;
    }

    const btn = document.getElementById('eventSubmitButton');
    if (!(btn instanceof HTMLButtonElement)) {
        console.error('Event submit button not found. Check the event modal markup.');
        showValidationError('Unable to save the Event because the submit button is unavailable. Please refresh the page and try again.');
        return;
    }
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    let scheduleChecked = false;

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
        };

        // Refresh both schedules and rosters before saving. The visible list may
        // be stale if another Admin created or edited an Event in another tab.
        const scheduleApproved = await reviewScheduleBeforeSave(
            { ...payload, event_id: eventId || null }, participantMode, editingTargetKind
        );
        scheduleChecked = true;
        if (!scheduleApproved) return;

        if (participantMode === 'grade' && editingTargetKind !== 'legacy-grade') {
            if (!applicableSchoolYear) throw new Error('Select an applicable school year before saving.');
            const { data, error } = await supabaseClient.rpc('save_grade_targeted_event', {
                p_event: payload,
                p_school_year_id: applicableSchoolYear.id,
                p_targets: getNormalizedRules(),
                p_event_id: isEdit ? eventId : null,
            });
            if (error) throw error;
            if (!data) throw new Error('The Event save did not return an Event ID.');
        } else if (isEdit && editingTargetKind === 'legacy-grade') {
            // Metadata-only edit: keep legacy targets and the existing roster intact.
            const { error } = await supabaseClient.from('events').update(payload).eq('event_id', eventId);
            if (error) throw error;
        } else {
            // Preserve the committed Individual Event write sequence until its
            // separate deletion-integrity work is reviewed and released.
            const individualPayload = { ...payload, target_grade_level: null, target_section: null };
            let savedEventId = eventId;
            let saveErr;

            if (isEdit) {
                const { error } = await supabaseClient.from('events').update(individualPayload).eq('event_id', eventId);
                saveErr = error;
                savedEventId = eventId;
            } else {
                const { data, error } = await supabaseClient.from('events').insert(individualPayload).select('event_id');
                saveErr = error;
                savedEventId = data && data[0] ? data[0].event_id : null;
            }

            if (saveErr) throw saveErr;
            if (savedEventId) {
                if (isEdit) {
                    await supabaseClient.from('event_participants').delete().eq('event_id', savedEventId);
                }
                const studentIdsToInsert = new Set(selectedStudentIds);
                if (studentIdsToInsert.size > 0) {
                    const participants = Array.from(studentIdsToInsert).map(studentId => ({
                        event_id: savedEventId,
                        student_id: studentId,
                        added_by: null,
                    }));
                    const { error: pError } = await supabaseClient.from('event_participants').insert(participants);
                    if (pError) throw pError;
                }
            }
        }

        showToast(isEdit ? 'Event updated successfully!' : 'Event added successfully!');
        closeModal();
        await loadEvents();
    } catch (err) {
        console.error('Save event error:', err);
        showValidationError((scheduleChecked
            ? 'The Event could not be saved. '
            : 'The Event schedule or participants could not be checked. Nothing was saved. ') +
            (err.message || 'Please try again.'));
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
});

const pendingEventDeletes = new Set();
async function deleteEvent(eventId, eventName) {
    if (pendingEventDeletes.has(eventId)) return;
    const confirmed = await UIFeedback.confirm({ title: 'Delete event?', message: `Delete "${eventName}" and its associated attendance records?`, confirmText: 'Delete event', type: 'danger' });
    if (!confirmed || pendingEventDeletes.has(eventId)) return;

    pendingEventDeletes.add(eventId);
    try {
        await supabaseClient.from('event_attendance').delete().eq('event_id', eventId);
        await supabaseClient.from('event_participants').delete().eq('event_id', eventId);
        const { error } = await supabaseClient.from('events').delete().eq('event_id', eventId);
        if (error) throw error;

        showToast(`"${eventName}" deleted successfully.`);
        await loadEvents();
    } catch (err) {
        console.error('Delete event error:', err);
        UIFeedback.error('Error deleting event: ' + (err.message || err));
    } finally {
        pendingEventDeletes.delete(eventId);
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    document.getElementById('eventForm').reset();
    updateDatePickerTrigger(document.getElementById('eventDate'));
    updateDatePickerTrigger(document.getElementById('eventEndDate'));
    updateTimePickerTrigger(document.getElementById('timeStart'));
    updateTimePickerTrigger(document.getElementById('timeEnd'));
    document.getElementById('eventId').value = '';

    selectedGrades.clear();
    gradeSectionTargets.clear();
    document.getElementById('gradeSectionGroups').style.display = '';
    applicableSchoolYear = null;
    editingTargetKind = 'new';
    const grades = ['Kinder', ...Array.from({ length: 10 }, (_, i) => `Grade ${i + 1}`)];
    renderGradeOptions(grades);
    renderGradeSectionGroups();
    
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
    document.getElementById('participantMode').disabled = false;
    document.getElementById('gradeMultiSelect').removeAttribute('inert');
    document.getElementById('gradeSectionGroups').style.display = '';
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
    document.getElementById('gradeSectionGroups').style.display = '';
    if (ev.targetSummaryUnavailable || !Array.isArray(ev.normalizedTargets)) {
        UIFeedback.error('Event targeting could not be verified. Refresh after the approved migration is installed.');
        return;
    }

    document.getElementById('eventId').value = ev.event_id;
    document.getElementById('eventName').value = ev.event_name || '';
    document.getElementById('eventDate').value = ev.event_date || '';
    updateDatePickerTrigger(document.getElementById('eventDate'));
    document.getElementById('eventType').value = ev.event_type || '';
    document.getElementById('timeStart').value = ev.time_start || '';
    document.getElementById('timeEnd').value = ev.time_end || '';
    updateTimePickerTrigger(document.getElementById('timeStart'));
    updateTimePickerTrigger(document.getElementById('timeEnd'));
    document.getElementById('location').value = ev.location || '';
    document.getElementById('description').value = ev.description || '';

    const hasEndDate = ev.end_date && ev.end_date !== ev.event_date;
    document.getElementById('isMultiDay').checked = hasEndDate;
    document.getElementById('eventEndDate').value = hasEndDate ? ev.end_date : '';
    updateDatePickerTrigger(document.getElementById('eventEndDate'));
    toggleEndDate();

    selectedGrades.clear();
    gradeSectionTargets.clear();
    editingTargetKind = ev.normalizedTargets.length ? 'normalized'
        : ev.target_grade_level ? 'legacy-grade' : 'individual';
    await loadGradeLevels(ev.normalizedTargets[0]?.school_year_id || null);
    if (editingTargetKind === 'normalized') {
        for (const target of ev.normalizedTargets) {
            selectedGrades.add(target.grade_level);
            gradeSectionTargets.set(target.grade_level, target.all_sections ? null
                : new Set((target.event_grade_target_sections || []).map(link => link.section_id)));
        }
    } else if (editingTargetKind === 'legacy-grade') {
        ev.target_grade_level.split(',').map(g => g.trim()).filter(Boolean)
            .forEach(g => selectedGrades.add(g));
        initialLegacyTarget = [...selectedGrades].sort().join(',');
        document.getElementById('gradeSectionGroups').style.display = 'none';
        document.getElementById('participantPreview').textContent =
            `Legacy targeting: ${EventTargets.legacySummary(ev)}. Its roster is preserved; changing targeting requires a separate review.`;
    }
    renderGradeOptions(['Kinder', ...Array.from({ length: 10 }, (_, i) => `Grade ${i + 1}`)]);
    renderGradeSectionGroups();
    await loadEventParticipants(ev.event_id);
    if (editingTargetKind === 'individual') {
        selectedStudentIds = new Set(currentEventParticipants.map(p => p.student_id));
        await preloadStudentNames(Array.from(selectedStudentIds));
    } else {
        selectedStudentIds.clear();
    }
    document.getElementById('participantMode').value = editingTargetKind === 'individual' ? 'individual' : 'grade';
    document.getElementById('participantMode').disabled = true;
    if (editingTargetKind === 'legacy-grade') document.getElementById('gradeMultiSelect').setAttribute('inert', '');
    else document.getElementById('gradeMultiSelect').removeAttribute('inert');
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
        <div class="multi-select-option ${selectedGrades.has(g) ? 'selected' : ''}"
             data-value="${escHtml(g)}" onclick="toggleGrade('${g}')">
            <i class="fa-solid ${selectedGrades.has(g) ? 'fa-check-square' : 'fa-square'}"></i>
            <span>${escHtml(g)}</span>
        </div>
    `).join('');
    updateGradeTrigger();
}

function toggleDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains('open');
    document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.multi-select-trigger').forEach(t => t.classList.remove('active'));
    if (!isOpen) {
        dropdown.classList.add('open');
        dropdown.previousElementSibling?.classList.add('active');
    }
}

document.addEventListener('click', function (e) {
    if (!e.target.closest('.multi-select')) {
        document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('open'));
        document.querySelectorAll('.multi-select-trigger').forEach(t => t.classList.remove('active'));
    }
});

function toggleGrade(grade) {
    if (selectedGrades.has(grade)) {
        selectedGrades.delete(grade);
        gradeSectionTargets.delete(grade);
    } else {
        selectedGrades.add(grade);
        gradeSectionTargets.set(grade, null); // Newly selected grades use All Sections.
    }
    renderGradeOptions(['Kinder', ...Array.from({ length: 10 }, (_, i) => `Grade ${i + 1}`)]);
    renderGradeSectionGroups();
}

function toggleAllGrades() {
    const grades = ['Kinder', ...Array.from({ length: 10 }, (_, i) => `Grade ${i + 1}`)];
    if (selectedGrades.size === grades.length) {
        selectedGrades.clear();
        gradeSectionTargets.clear();
    } else {
        grades.forEach(grade => {
            selectedGrades.add(grade);
            gradeSectionTargets.set(grade, null);
        });
    }
    renderGradeOptions(grades);
    renderGradeSectionGroups();
}

function updateGradeTrigger() {
    const trigger = document.getElementById('gradeTriggerText');
    if (!trigger) return;
    const count = selectedGrades.size;
    trigger.textContent = count === 0 ? '-- Select Grades --'
        : count === 1 ? [...selectedGrades][0] : `${count} grades selected`;
    const icon = document.getElementById('gradeAllIcon');
    if (icon) icon.className = count === 11 ? 'fa-solid fa-check-square' : 'fa-solid fa-square';
    document.getElementById('targetGradeLevel').value = [...selectedGrades].join(',');
}

function setAllSectionsForGrade(grade) {
    if (!selectedGrades.has(grade)) return;
    gradeSectionTargets.set(grade, null);
    renderGradeSectionGroups();
}

function toggleGradeSection(grade, sectionId, checked) {
    const section = allSectionsData.find(s => s.section_id === sectionId);
    if (!selectedGrades.has(grade) || !applicableSchoolYear ||
        section?.grade_level !== grade || section?.school_year_id !== applicableSchoolYear.id) return;
    const ids = new Set(gradeSectionTargets.get(grade) || []);
    if (checked) ids.add(sectionId);
    else ids.delete(sectionId);
    gradeSectionTargets.set(grade, ids.size ? ids : null);
    renderGradeSectionGroups();
}

function renderGradeSectionGroups() {
    const container = document.getElementById('gradeSectionGroups');
    if (!container) return;
    const openGrades = new Set([...container.querySelectorAll('details[open]')].map(el => el.dataset.grade));
    container.innerHTML = [...selectedGrades].map(grade => {
        const sections = allSectionsData.filter(section =>
            section.grade_level === grade && section.school_year_id === applicableSchoolYear?.id);
        const chosen = gradeSectionTargets.get(grade);
        const label = chosen === null || chosen === undefined ? 'All Sections' :
            `${chosen.size} specific section${chosen.size === 1 ? '' : 's'}`;
        return `<details class="grade-section-group" data-grade="${escHtml(grade)}" ${openGrades.has(grade) ? 'open' : ''}>
            <summary>${escHtml(grade)} <span>${label}</span></summary>
            <div class="grade-section-options">
                <label><input type="radio" name="sections-${escHtml(grade)}"
                    ${chosen == null ? 'checked' : ''} onchange="setAllSectionsForGrade('${grade}')"> All Sections</label>
                ${sections.map(section => `<label><input type="checkbox"
                    ${chosen?.has(section.section_id) ? 'checked' : ''}
                    onchange="toggleGradeSection('${grade}', '${section.section_id}', this.checked)">
                    ${escHtml(section.section_name)}</label>`).join('') ||
                    '<span class="multi-select-hint">No sections in this school year</span>'}
            </div>
        </details>`;
    }).join('');
    const customized = [...gradeSectionTargets.values()].filter(value => value instanceof Set).length;
    document.getElementById('gradeSectionSummary').textContent = selectedGrades.size
        ? `${selectedGrades.size} grade${selectedGrades.size === 1 ? '' : 's'} selected; ${customized} customized`
        : 'Select grades first';
    updateGradeTrigger();
    refreshParticipantPreview();
}

function getNormalizedRules() {
    if (!applicableSchoolYear || !selectedGrades.size) throw new Error('Select an applicable school year and at least one grade.');
    return [...selectedGrades].map(grade => {
        const selected = gradeSectionTargets.get(grade);
        const sectionIds = selected == null ? [] : [...selected];
        if (selected !== null && selected !== undefined && !sectionIds.length) throw new Error(`${grade} needs a section or All Sections.`);
        for (const id of sectionIds) {
            if (!allSectionsData.some(section => section.section_id === id &&
                section.grade_level === grade && section.school_year_id === applicableSchoolYear.id)) {
                throw new Error(`A selected section does not belong to ${grade} in this school year.`);
            }
        }
        return { grade_level: grade, all_sections: selected == null, section_ids: sectionIds };
    });
}

async function refreshParticipantPreview() {
    const el = document.getElementById('participantPreview');
    if (!el || editingTargetKind === 'legacy-grade') return;
    const sequence = ++previewSequence;
    if (!applicableSchoolYear || !selectedGrades.size) {
        el.textContent = 'Select grades to preview eligible students.';
        return;
    }
    el.textContent = 'Checking eligible students...';
    try {
        const { data, error } = await supabaseClient.rpc('preview_event_grade_participants', {
            p_school_year_id: applicableSchoolYear.id, p_targets: getNormalizedRules(),
            p_event_id: editingTargetKind === 'normalized' ? document.getElementById('eventId').value || null : null,
        });
        if (error) throw error;
        if (sequence === previewSequence) {
            el.textContent = `${new Set((data || []).map(row => row.student_id)).size} currently eligible student(s). No participant records are written by preview.`;
        }
    } catch (error) {
        if (sequence === previewSequence) el.textContent = `Preview unavailable: ${error.message || error}`;
    }
}

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
            .select('student_id, first_name, middle_name, last_name, stud_id, current_grade_level, section_id, sections(section_name)')
            .eq('status', 'active');

        if (error) {
            const fb = await supabaseClient
                .from('students')
                .select('student_id, first_name, middle_name, last_name, stud_id, current_grade_level, section_id')
                .eq('status', 'active');
            if (fb.error) throw fb.error;
            modalAvailableStudents = (fb.data || []).map(s => ({ ...s, sections: null }));
        } else {
            modalAvailableStudents = data || [];
        }

        modalAvailableStudents.forEach(s => studentCache.set(s.student_id, s));

        if (gradeFilter) {
            modalAvailableStudents = modalAvailableStudents.filter(s =>
                s.current_grade_level === gradeFilter
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
        const info = `(${s.current_grade_level || 'Grade unavailable'} ${s.sections?.section_name || ''})`;
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
            .select('student_id, first_name, middle_name, last_name, stud_id, current_grade_level, sections(section_name)')
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
            .select('student_id, first_name, middle_name, last_name, stud_id, current_grade_level, sections(section_name)')
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
// EVENT SCHEDULE REVIEW
// ══════════════════════════════════════════════════════════

function formatEventSchedule(event) {
    const formatDate = date => new Date(date + 'T00:00:00')
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const dates = event.end_date && event.end_date !== event.event_date
        ? `${formatDate(event.event_date)} – ${formatDate(event.end_date)}`
        : formatDate(event.event_date);
    const times = event.time_start && event.time_end
        ? `${formatTime(event.time_start)} – ${formatTime(event.time_end)}`
        : 'All day';
    return `${dates} • ${times}`;
}

function showOverlapWarning(events) {
    const warningDiv = document.getElementById('overlapWarning');
    const detailsDiv = document.getElementById('overlapDetails');
    if (!warningDiv || !detailsDiv) return;
    detailsDiv.innerHTML = events.map(event =>
        `<strong>${escHtml(event.event_name)}</strong> — ${escHtml(formatEventSchedule(event))} at ${escHtml(event.location)}`
    ).join('<br>');
    warningDiv.classList.toggle('active', events.length > 0);
}

function hideOverlapWarning() {
    const warningDiv = document.getElementById('overlapWarning');
    if (warningDiv) warningDiv.classList.remove('active');
}

async function fetchScheduleEvents(candidate) {
    // Fetch once per page, never once per event. Re-read at submit so a second
    // Admin's changes are considered even if this page has been open awhile.
    const rows = [];
    const pageSize = 500;
    const lastDate = candidate.end_date || candidate.event_date;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabaseClient.from('events')
            .select('event_id,event_name,event_date,end_date,time_start,time_end,location,status')
            .lte('event_date', lastDate)
            .or(`end_date.gte.${candidate.event_date},and(end_date.is.null,event_date.gte.${candidate.event_date})`)
            .neq('status', 'cancelled')
            .order('event_date', { ascending: true })
            .order('event_id', { ascending: true })
            .range(offset, offset + pageSize - 1);
        if (error) throw error;
        const page = data || [];
        rows.push(...page);
        if (page.length < pageSize) break;
    }
    return EventScheduleConflicts.overlappingEvents(candidate, rows, candidate.event_id);
}

async function fetchOverlappingRosters(events) {
    const rows = [];
    const eventIds = events.map(event => event.event_id);
    const pageSize = 500;
    for (let start = 0; start < eventIds.length; start += 50) {
        const batch = eventIds.slice(start, start + 50);
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await supabaseClient.from('event_participants')
                .select('event_id,student_id')
                .in('event_id', batch)
                .order('event_id', { ascending: true })
                .order('student_id', { ascending: true })
                .range(offset, offset + pageSize - 1);
            if (error) throw error;
            const page = data || [];
            rows.push(...page);
            if (page.length < pageSize) break;
        }
    }
    return rows;
}

async function resolveSelectedStudentIds(participantMode, targetKind, eventId) {
    if (participantMode === 'individual') return [...selectedStudentIds];
    if (targetKind === 'legacy-grade') {
        // Legacy targeting is metadata-only on edit; its actual saved roster
        // remains authoritative. Re-read it in case another Admin changed it
        // after the edit form opened.
        const rows = await fetchOverlappingRosters([{ event_id: eventId }]);
        return rows.map(row => row.student_id);
    }
    if (!applicableSchoolYear) throw new Error('The applicable school year is unavailable.');
    const students = new Set();
    const rules = getNormalizedRules();
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabaseClient.rpc('preview_event_grade_participants', {
            p_school_year_id: applicableSchoolYear.id,
            p_targets: rules,
            p_event_id: eventId || null,
        }).order('student_id', { ascending: true }).range(offset, offset + pageSize - 1);
        if (error) throw error;
        const page = data || [];
        page.forEach(row => students.add(row.student_id));
        if (page.length < pageSize) break;
    }
    return [...students];
}

async function reviewScheduleBeforeSave(candidate, participantMode, targetKind) {
    // This is an Admin UI preflight, not an atomic database constraint: direct
    // or concurrent Supabase writes can still create participant conflicts.
    const [overlapping, selectedIds] = await Promise.all([
        fetchScheduleEvents(candidate),
        resolveSelectedStudentIds(participantMode, targetKind, candidate.event_id),
    ]);
    const rosters = selectedIds.length && overlapping.length
        ? await fetchOverlappingRosters(overlapping) : [];
    const participantMatches = EventScheduleConflicts.participantConflicts(
        selectedIds, overlapping, rosters
    );
    if (participantMatches.length) {
        // A participant conflict blocks saving, so the informational location
        // warning must not imply that "Create Anyway" could override it.
        hideOverlapWarning();
        const count = new Set(participantMatches.flatMap(match => [...match.studentIds])).size;
        await UIFeedback.error(
            `${count} selected participant${count === 1 ? ' is' : 's are'} already assigned to another overlapping event. Change the participants or schedule before saving.`,
            'Participant Schedule Conflict'
        );
        return false;
    }

    const locationMatches = EventScheduleConflicts.locationConflicts(candidate, overlapping);
    showOverlapWarning(locationMatches);
    if (!locationMatches.length) return true;
    const first = locationMatches[0];
    const others = locationMatches.length > 1
        ? ` (${locationMatches.length - 1} more location conflict${locationMatches.length === 2 ? '' : 's'})`
        : '';
    return UIFeedback.confirm({
        title: 'Heads Up: Location Conflict',
        type: 'warning',
        message: `Another event is scheduled at this location during the selected time. ${first.event_name}${others}. Location: ${first.location}. Schedule: ${formatEventSchedule(first)}. You may still ${candidate.event_id ? 'update' : 'create'} this event.`,
        cancelText: 'Review Schedule',
        confirmText: candidate.event_id ? 'Update Anyway' : 'Create Anyway',
    });
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
    } else {
        endDateRow.style.display = 'none';
        endDateInput.value = '';
        updateDatePickerTrigger(endDateInput);
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

    document.getElementById('eventViewModal')?.addEventListener('click', function (e) {
        if (e.target === this) closeEventView();
    });

    document.getElementById('studentModal')?.addEventListener('click', function (e) {
        if (e.target === this) closeStudentModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const eventViewModal = document.getElementById('eventViewModal');
            if (eventViewModal && eventViewModal.classList.contains('active')) {
                closeEventView();
                return;
            }
            const studentModal = document.getElementById('studentModal');
            if (studentModal && studentModal.classList.contains('active')) {
                closeStudentModal();
                return;
            }
            const eventModal = document.getElementById('eventModal');
            if (eventModal && eventModal.classList.contains('active')) closeModal();
        }
    });
}

function setTableLoading(on) {
    const tbody = document.getElementById('eventsTableBody');
    if (tbody && on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading events…</td></tr>`;
}

function showTableError(msg) {
    const tbody = document.getElementById('eventsTableBody');
    if (tbody) tbody.innerHTML = `
        <tr><td colspan="7" class="empty-cell" style="color:#dc2626">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:36px;display:block;margin-bottom:10px"></i>
            ${escHtml(msg)}
        </td></tr>`;
}

function showValidationError(message) {
    clearValidationError();
    const div = document.createElement('div');
    div.className = 'validation-error';
    div.setAttribute('role', 'alert');
    div.setAttribute('aria-live', 'assertive');
    div.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i><span>${escHtml(message)}</span>`;
    const form = document.getElementById('eventForm');
    if (form && form.parentElement) {
        form.parentElement.insertBefore(div, form);
        div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    const eventDate = document.getElementById('eventDate').value;
    const isMultiDay = document.getElementById('isMultiDay').checked;
    const eventEndDate = document.getElementById('eventEndDate').value;
    const timeStart = document.getElementById('timeStart').value;
    const timeEnd = document.getElementById('timeEnd').value;

    const todayStr = getManilaNow().toLocaleDateString('en-CA');
    let error = null; // only ever show ONE message at a time

    // 1) Date validity — start date in the past, end date in the past, or end before start
    if (!eventDate) {
        error = { field: 'eventDate', msg: 'Please select an event date' };
    } else if (isMultiDay && !eventEndDate) {
        error = { field: 'eventEndDate', msg: 'Please select an end date for this multi-day event' };
    } else if (eventDate < todayStr) {
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

    // Names alone are not unique: two distinct groups may schedule events with
    // the same name. The participant/schedule check runs before either save.
    // Immediate, informational location feedback. The fresh roster check
    // and final warning confirmation happen on submit.
    if (eventDate) {
        showOverlapWarning(EventScheduleConflicts.locationConflicts({
            event_date: eventDate,
            end_date: isMultiDay ? eventEndDate : null,
            time_start: timeStart || null,
            time_end: timeEnd || null,
            location: document.getElementById('location').value,
            status: 'upcoming',
        }, allEvents, eventId));
    } else {
        hideOverlapWarning();
    }

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
