'use strict';

let storedGateSettings = null;
let systemSettings = null;
let savingSettings = false;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('gateSmsEnabled').addEventListener('change', updateEffectiveSms);
    document.addEventListener('click', openSavedGateScanner, true);
    loadSettings();
});

function openSavedGateScanner(event) {
    if (window.AppDeployment?.isWeb) return;
    const link = event.target.closest('a.header-attendance-btn');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (!storedGateSettings) {
        UIFeedback.error('Gate settings are still loading. Try again in a moment.', 'Scanner unavailable');
        return;
    }
    const mode = storedGateSettings.scanMethod === 'qr' ? 'qr' : 'face';
    const page = mode === 'qr' ? 'qrAttendance.html' : 'entryExitScanner.html';
    const target = new URL(`../gate/${page}?v=20260927b`, window.location.href);
    sessionStorage.setItem('allowed_admin_route', target.pathname);
    window.location.assign(target.href);
}

async function loadSettings() {
    const saveButton = document.querySelector('.btn-save');
    saveButton.disabled = true;
    try {
        [storedGateSettings, systemSettings] = await Promise.all([
            AppSettings.load(supabaseClient, 'gate', { refresh: true }),
            AppSettings.load(supabaseClient, 'system', { refresh: true })
        ]);
        applyToForm(storedGateSettings);
        document.getElementById('antiSpoofManaged').textContent = AppSettings.enabled(systemSettings, 'anti_spoof_enabled')
            ? 'Enabled by Super Admin' : 'Disabled by Super Admin';
        document.getElementById('systemSmsManaged').textContent = AppSettings.enabled(systemSettings, 'sms_enabled')
            ? 'Enabled by Super Admin' : 'Disabled by Super Admin';
        updateEffectiveSms();
        saveButton.disabled = false;
    } catch (error) {
        console.error('Gate settings unavailable:', error);
        document.getElementById('systemSmsManaged').textContent = 'System setting unavailable';
        document.getElementById('antiSpoofManaged').textContent = 'System setting unavailable';
        document.getElementById('gateSmsEffective').textContent = 'Settings unavailable; saving is disabled.';
        UIFeedback.error('Gate settings could not be loaded. Apply the settings migration or check the connection.', 'Settings unavailable');
    }
}

function applyToForm(settings) {
    for (const key of ['gateOpen', 'gateClose', 'lateThreshold', 'scanMethod', 'cooldown']) {
        document.getElementById(key).value = key === 'scanMethod' && settings[key] === 'both' ? 'face' : settings[key];
    }
    for (const [id, key] of [['enforceGateHours', 'enforceGateHours'], ['autoExit', 'autoExit'], ['gateSmsEnabled', 'sms_enabled']]) {
        document.getElementById(id).checked = AppSettings.enabled(settings, key);
    }
    updateEffectiveSms();
}

function updateEffectiveSms() {
    const note = document.getElementById('gateSmsEffective');
    if (!systemSettings) return;
    const preference = document.getElementById('gateSmsEnabled').checked;
    const master = AppSettings.enabled(systemSettings, 'sms_enabled');
    note.textContent = !master
        ? `Stored preference: ${preference ? 'On' : 'Off'}. Currently unavailable because Master SMS is off.`
        : `Stored preference: ${preference ? 'On' : 'Off'}. Gate SMS is ${preference ? 'active' : 'paused'} after the engine's next refresh (about 15 seconds).`;
}

function formValues() {
    return {
        enforceGateHours: document.getElementById('enforceGateHours').checked,
        gateOpen: document.getElementById('gateOpen').value,
        gateClose: document.getElementById('gateClose').value,
        lateThreshold: document.getElementById('lateThreshold').value,
        scanMethod: document.getElementById('scanMethod').value,
        autoExit: document.getElementById('autoExit').checked,
        cooldown: Number(document.getElementById('cooldown').value),
        sms_enabled: document.getElementById('gateSmsEnabled').checked
    };
}

function validate(values) {
    const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const key of ['gateOpen', 'gateClose', 'lateThreshold']) {
        if (!validTime.test(values[key])) return { id: key, message: 'Enter a valid time.' };
    }
    if (values.gateOpen >= values.gateClose) return { id: 'gateClose', message: 'Close time must be after Open time.' };
    if (!['face', 'qr'].includes(values.scanMethod)) return { id: 'scanMethod', message: 'Choose a valid scan method.' };
    if (!Number.isInteger(values.cooldown) || values.cooldown < 1 || values.cooldown > 300) {
        return { id: 'cooldown', message: 'Enter a whole number from 1 to 300 seconds.' };
    }
    return null;
}

async function saveSettings() {
    if (savingSettings || !storedGateSettings) return;
    const values = formValues();
    const validation = validate(values);
    if (validation) return UIFeedback.fieldError(document.getElementById(validation.id), validation.message);
    const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => String(value) !== storedGateSettings[key]));
    if (!AppSettings.hasSaved('gate', 'cooldown')) changes.cooldown = values.cooldown;
    if (!Object.keys(changes).length) return UIFeedback.toast({ type: 'info', message: 'No changes to save.' });
    savingSettings = true;
    const button = document.querySelector('.btn-save');
    button.disabled = true;
    try {
        await AppSettings.save(supabaseClient, 'gate', changes);
        const previous = Object.fromEntries(Object.keys(changes).map(key => [key, storedGateSettings[key]]));
        storedGateSettings = { ...storedGateSettings, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, String(value)])) };
        await logSystemAudit({ action: 'UPDATE', moduleName: 'entry_exit', pageName: 'settings.html',
            targetTable: 'gate_settings', details: { old_values: previous, new_values: changes } });
        updateEffectiveSms();
        UIFeedback.success('Gate settings were saved.', 'Settings saved');
    } catch (error) {
        console.error('Gate settings could not be saved:', error);
        UIFeedback.error('Gate settings could not be saved. No local-only copy was created.', 'Save failed');
    } finally {
        savingSettings = false;
        button.disabled = false;
    }
}

async function resetSettings() {
    if (!await UIFeedback.confirm({ title: 'Reset Gate Settings',
        message: 'Restore defaults in this form? Click Save to apply them.',
        confirmText: 'Reset defaults', type: 'warning' })) return;
    applyToForm(AppSettings.defaults.gate);
    UIFeedback.toast({ type: 'info', message: 'Defaults restored in the form. Click Save to apply.' });
}
