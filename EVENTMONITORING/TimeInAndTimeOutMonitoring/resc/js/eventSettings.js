'use strict';

let savedEventSettings = null;
let systemEventSettings = null;
let eventSettingsSaving = false;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('eventSmsEnabled').addEventListener('change', showEventSmsStatus);
    document.getElementById('saveEventSettings').addEventListener('click', saveEventSettings);
    loadEventSettings();
});

async function loadEventSettings() {
    try {
        [savedEventSettings, systemEventSettings] = await Promise.all([
            AppSettings.load(supabaseClient, 'event', { refresh: true }),
            AppSettings.load(supabaseClient, 'system', { refresh: true })
        ]);
        const grace = Number(savedEventSettings.late_grace_minutes);
        document.getElementById('lateGraceMinutes').value = Number.isInteger(grace) && grace >= 0 && grace <= 99 ? grace : 15;
        document.getElementById('eventSmsEnabled').checked = AppSettings.enabled(savedEventSettings, 'sms_enabled');
        document.getElementById('systemSmsStatus').textContent = AppSettings.enabled(systemEventSettings, 'sms_enabled')
            ? 'Enabled by Super Admin' : 'Disabled by Super Admin';
        document.getElementById('antiSpoofStatus').textContent = AppSettings.enabled(systemEventSettings, 'anti_spoof_enabled')
            ? 'Enabled by Super Admin' : 'Disabled by Super Admin';
        showEventSmsStatus();
        document.getElementById('lateGraceMinutes').disabled = false;
        document.getElementById('eventSmsEnabled').disabled = false;
        document.getElementById('saveEventSettings').disabled = false;
    } catch (error) {
        console.error('Event settings could not be loaded:', error);
        UIFeedback.error('Event settings are unavailable. Apply the settings migration or check the connection.', 'Settings unavailable');
    }
}

function showEventSmsStatus() {
    if (!systemEventSettings) return;
    const preference = document.getElementById('eventSmsEnabled').checked;
    document.getElementById('eventSmsStatus').textContent = AppSettings.enabled(systemEventSettings, 'sms_enabled')
        ? `Stored preference: ${preference ? 'On' : 'Off'}. Event SMS is ${preference ? 'active' : 'paused'} after the engine's next refresh (about 15 seconds).`
        : `Stored preference: ${preference ? 'On' : 'Off'}. Currently unavailable because Master SMS is off.`;
}

async function saveEventSettings() {
    if (eventSettingsSaving || !savedEventSettings) return;
    const graceInput = document.getElementById('lateGraceMinutes');
    const grace = Number(graceInput.value);
    if (!Number.isInteger(grace) || grace < 0 || grace > 99 || graceInput.value.trim() === '') {
        UIFeedback.fieldError(graceInput, 'Enter a whole number from 0 to 99 minutes.');
        return;
    }
    const desired = { late_grace_minutes: String(grace), sms_enabled: String(document.getElementById('eventSmsEnabled').checked) };
    const changes = Object.fromEntries(Object.entries(desired).filter(([key, value]) => value !== savedEventSettings[key]));
    if (!Object.keys(changes).length) return UIFeedback.toast({ type: 'info', message: 'No changes to save.' });
    eventSettingsSaving = true;
    const button = document.getElementById('saveEventSettings');
    button.disabled = true;
    try {
        await AppSettings.save(supabaseClient, 'event', changes);
        const previous = Object.fromEntries(Object.keys(changes).map(key => [key, savedEventSettings[key]]));
        savedEventSettings = { ...savedEventSettings, ...changes };
        await logSystemAudit({ action: 'UPDATE', moduleName: 'event', pageName: 'eventSettings.html',
            targetTable: 'event_settings', details: { old_values: previous, new_values: changes } });
        showEventSmsStatus();
        UIFeedback.success('Event settings were saved.', 'Settings saved');
    } catch (error) {
        console.error('Event settings could not be saved:', error);
        UIFeedback.error('Event settings could not be saved. Please try again.', 'Save failed');
    } finally {
        eventSettingsSaving = false;
        button.disabled = false;
    }
}
