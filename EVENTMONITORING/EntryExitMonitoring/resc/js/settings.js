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
    smsEnabled:     false,
    notifyEntryOnly:false
};

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
    setCheck('smsEnabled',     toBool(s.smsEnabled));
    setCheck('notifyEntryOnly',toBool(s.notifyEntryOnly));
}

async function saveSettings() {
    const settings = {
        gateOpen:        document.getElementById('gateOpen').value,
        gateClose:       document.getElementById('gateClose').value,
        lateThreshold:   document.getElementById('lateThreshold').value,
        scanMethod:      document.getElementById('scanMethod').value,
        antiSpoof:       document.getElementById('antiSpoof').checked,
        autoExit:        document.getElementById('autoExit').checked,
        cooldown:        parseInt(document.getElementById('cooldown').value, 10) || 10,
        smsEnabled:      document.getElementById('smsEnabled').checked,
        notifyEntryOnly: document.getElementById('notifyEntryOnly').checked
    };

    try {
        const upserts = Object.entries(settings).map(([key, value]) => ({ key, value: String(value) }));
        const { error } = await supabaseClient
            .from('gate_settings')
            .upsert(upserts, { onConflict: 'key' });
        if (error) throw error;
        showToast('Settings saved!');
    } catch (e) {
        // Fallback: localStorage
        console.warn('[settings] Supabase write failed, saving to localStorage:', e.message);
        localStorage.setItem('gate_settings', JSON.stringify(settings));
        showToast('Settings saved locally (DB unavailable).');
    }
}

function resetSettings() {
    if (!confirm('Reset all settings to defaults?')) return;
    applyToForm(DEFAULTS);
    showToast('Defaults restored. Click Save to apply.');
}

function setInput(id, val) { const e = document.getElementById(id); if (e) e.value = val ?? ''; }
function setCheck(id, val) { const e = document.getElementById(id); if (e) e.checked = !!val; }
function toBool(v) { return v === true || v === 'true'; }

function showToast(msg) {
    const t = document.getElementById('toast');
    const m = document.getElementById('toastMsg');
    if (!t || !m) return;
    m.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}