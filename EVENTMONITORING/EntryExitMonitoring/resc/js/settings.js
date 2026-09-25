/* ============================================================
   StudentEntryExit/resc/js/settings.js
   Persists to Supabase table: gate_settings (key, value)
   Falls back to localStorage if table not yet created.
============================================================ */
'use strict';

const DEFAULTS = {
    gateOpen:       '06:00',
    gateClose:      '18:00',
    lateThreshold:  '07:30',
    scanMethod:     'face',
    antiSpoof:      true,
    autoExit:       true,
    cooldown:       10,
    emailEnabled:     false,
    notifyEntryOnly:false
};
let savingSettings = false;
let resettingSettings = false;

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) { console.error('Supabase not initialised.'); return; }
    loadSettings();
});

async function loadSettings() {
    try {
        const { data, error } = await supabaseClient
            .from('gate_settings')
            .select('key, value');

        if (error) throw error;

        const map = {};
        (data || []).forEach(r => { map[r.key] = r.value; });
        applyToForm({ ...DEFAULTS, ...map });
    } catch (e) {
        // Fallback: localStorage
        console.warn('[settings] Supabase read failed, using localStorage:', e.message);
        const saved = JSON.parse(localStorage.getItem('gate_settings') || '{}');
        applyToForm({ ...DEFAULTS, ...saved });
    }
}

function applyToForm(s) {
    setInput('gateOpen',       s.gateOpen);
    setInput('gateClose',      s.gateClose);
    setInput('lateThreshold',  s.lateThreshold);
    setInput('scanMethod',     s.scanMethod);
    setInput('cooldown',       s.cooldown);
    setCheck('antiSpoof',      toBool(s.antiSpoof));
    setCheck('autoExit',       toBool(s.autoExit));
    setCheck('emailEnabled',     toBool(s.emailEnabled));
    setCheck('notifyEntryOnly',toBool(s.notifyEntryOnly));
}

async function saveSettings() {
    if (savingSettings) return;
    savingSettings = true;
    const saveButton = document.querySelector('.btn-save');
    if (saveButton) saveButton.disabled = true;
    const settings = {
        gateOpen:        document.getElementById('gateOpen').value,
        gateClose:       document.getElementById('gateClose').value,
        lateThreshold:   document.getElementById('lateThreshold').value,
        scanMethod:      document.getElementById('scanMethod').value,
        antiSpoof:       document.getElementById('antiSpoof').checked,
        autoExit:        document.getElementById('autoExit').checked,
        cooldown:        parseInt(document.getElementById('cooldown').value, 10) || 10,
        emailEnabled:      document.getElementById('emailEnabled').checked,
        notifyEntryOnly: document.getElementById('notifyEntryOnly').checked
    };

    try {
        const upserts = Object.entries(settings).map(([key, value]) => ({ key, value: String(value) }));
        const { error } = await supabaseClient
            .from('gate_settings')
            .upsert(upserts, { onConflict: 'key' });
        if (error) throw error;
        UIFeedback.success('Gate settings were saved.', 'Settings saved');
    } catch (e) {
        // Fallback: localStorage
        console.warn('[settings] Supabase write failed, saving to localStorage:', e.message);
        try {
            localStorage.setItem('gate_settings', JSON.stringify(settings));
            UIFeedback.toast({
                type: 'warning',
                title: 'Saved on this device',
                message: 'The database is unavailable. These settings were saved locally.'
            });
        } catch (storageError) {
            console.error('Gate settings could not be saved:', storageError);
            UIFeedback.error('Gate settings could not be saved. Please try again.', 'Save failed');
        }
    } finally {
        savingSettings = false;
        if (saveButton) saveButton.disabled = false;
    }
}

async function resetSettings() {
    if (resettingSettings) return;
    resettingSettings = true;
    try {
        if (!await UIFeedback.confirm({
            title: 'Reset Gate Settings',
            message: 'Restore the default values in this form? Click Save to apply them.',
            confirmText: 'Reset defaults',
            type: 'warning'
        })) return;
        applyToForm(DEFAULTS);
        UIFeedback.toast({
            type: 'info',
            title: 'Defaults restored',
            message: 'Click Save to apply these settings.'
        });
    } finally {
        resettingSettings = false;
    }
}

function setInput(id, val) { const e = document.getElementById(id); if (e) e.value = val ?? ''; }
function setCheck(id, val) { const e = document.getElementById(id); if (e) e.checked = !!val; }
function toBool(v) { return v === true || v === 'true'; }
