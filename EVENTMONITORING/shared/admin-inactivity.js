/* Browser-only inactivity guard for authenticated Admin management pages. */
(function (root) {
    'use strict';

    const DEFAULT_MINUTES = 3;
    const WARNING_MS = 30 * 1000;
    const ACTIVITY_WRITE_MS = 1000;
    const SETTING_KEY = 'admin_inactivity_timeout_minutes';
    const CONFIG_EVENT_KEY = 'admin-inactivity-config-changed';
    const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'click', 'touchstart', 'keydown', 'wheel'];
    let active = null;

    function validMinutes(value) {
        const text = String(value ?? '');
        if (!/^([3-9]|[1-9][0-9]+)$/.test(text)) return null;
        const minutes = Number(text);
        return Number.isSafeInteger(minutes) ? minutes : null;
    }

    function readNumber(key) {
        try {
            const value = Number(root.localStorage.getItem(key));
            return Number.isFinite(value) && value > 0 ? value : 0;
        } catch (_) { return 0; }
    }

    function writeNumber(key, value) {
        try { root.localStorage.setItem(key, String(value)); } catch (_) { /* BroadcastChannel may still sync tabs. */ }
    }

    function clearLocalAuthFallback(state) {
        // The app uses the supabase-js default localStorage adapter. If the
        // network rejects signOut, remove only this project's browser session.
        try {
            const host = new URL(state.projectUrl).hostname;
            if (!/^[-a-z0-9]+\.supabase\.co$/i.test(host)) return;
            root.localStorage.removeItem(`sb-${host.split('.')[0]}-auth-token`);
        } catch (_) { /* Login navigation remains the final browser boundary. */ }
    }

    function sessionIdentity(session) {
        // Supabase session_id remains stable across access-token refreshes.
        // It is only a storage namespace, never an authorization decision.
        let sessionId = '';
        try {
            const payload = session.access_token.split('.')[1];
            sessionId = JSON.parse(root.atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).session_id || '';
        } catch (_) { /* Old tokens can omit session_id. */ }
        return `${session.user.id}:${sessionId || 'browser'}`;
    }

    function dismissWarning(state) {
        if (!state.warning) return;
        state.warning = false;
        state.dismissedWarning = true;
        root.UIFeedback?.dismissDialog();
    }

    function activity(state, force = false) {
        if (state.leaving || (state.warning && !force)) return;
        const now = Date.now();
        state.lastActivity = now;
        if (force || now - state.lastWrite >= ACTIVITY_WRITE_MS) {
            state.lastWrite = now;
            writeNumber(state.activityKey, now);
            state.channel?.postMessage({ type: 'activity', at: now });
        }
        dismissWarning(state);
    }

    async function logout(state, reason, timeoutNotice = false) {
        if (state.leaving) return;
        // Recheck shared state before expiring this tab: a different tab may
        // have recorded activity immediately before this timer fired.
        if (reason === 'timeout' && Math.max(state.lastActivity, readNumber(state.activityKey))
                + state.minutes * 60000 > Date.now()) return;
        state.leaving = true;
        dismissWarning(state);
        if (reason !== 'remote') {
            writeNumber(state.logoutKey, `${reason}:${Date.now()}`);
            state.channel?.postMessage({ type: 'logout', reason });
        }
        if (reason === 'timeout' || timeoutNotice) {
            root.sessionStorage.setItem('admin_inactivity_notice', String(state.minutes));
        }
        try {
            // Local scope ends this browser session without revoking sessions
            // on the administrator's other devices.
            const { error } = await state.client.auth.signOut({ scope: 'local' });
            if (error) clearLocalAuthFallback(state);
        } catch (_) { clearLocalAuthFallback(state); }
        root.sessionStorage.removeItem('user');
        root.sessionStorage.removeItem('manual_access_granted');
        root.sessionStorage.removeItem('manual_access_role');
        try { root.localStorage.removeItem(state.activityKey); } catch (_) { /* optional storage */ }
        root.location.replace(new URL('auth/login.html', state.appRoot).href);
    }

    function showWarning(state) {
        if (state.warning || state.leaving) return;
        state.warning = true;
        state.dismissedWarning = false;
        const remaining = Math.max(0, Math.ceil((state.lastActivity + state.minutes * 60000 - Date.now()) / 1000));
        root.UIFeedback.confirm({
            title: 'Session expiring',
            message: `Your session will expire due to inactivity in ${remaining} seconds.`,
            confirmText: 'Stay Signed In', cancelText: 'Log Out Now',
            type: 'warning', dismissible: false, replaceExisting: true
        }).then(stay => {
            if (state.dismissedWarning || state.leaving) return;
            state.warning = false;
            if (stay) activity(state, true);
            else logout(state, 'manual');
        });
    }

    function tick(state) {
        if (state.leaving) return;
        const shared = readNumber(state.activityKey);
        if (shared > state.lastActivity) {
            state.lastActivity = shared;
            dismissWarning(state);
        }
        const remaining = state.lastActivity + state.minutes * 60000 - Date.now();
        if (remaining <= 0) { void logout(state, 'timeout'); return; }
        if (remaining <= WARNING_MS) {
            showWarning(state);
            root.UIFeedback?.updateDialogMessage(
                `Your session will expire due to inactivity in ${Math.ceil(remaining / 1000)} seconds.`);
        } else dismissWarning(state);
    }

    async function reload() {
        const state = active;
        if (!state || state.leaving) return;
        try {
            const { data, error } = await state.client.from('system_settings')
                .select('value').eq('key', SETTING_KEY).maybeSingle();
            if (error) throw error;
            state.minutes = validMinutes(data?.value) || DEFAULT_MINUTES;
        } catch (_) {
            // Keep a previously loaded value on transient failures. Before a
            // successful load, the restrictive default of 3 minutes applies.
        }
        tick(state);
    }

    async function start({ client, userId, appRoot, projectUrl }) {
        if (active || !client || !userId || !appRoot) return;
        const { data, error } = await client.auth.getSession();
        const session = data?.session;
        if (error || !session || session.user.id !== userId) {
            root.sessionStorage.removeItem('user');
            root.location.replace(new URL('auth/login.html', appRoot).href);
            return;
        }
        const identity = sessionIdentity(session);
        const state = {
            client, appRoot, projectUrl, minutes: DEFAULT_MINUTES, leaving: false,
            warning: false, dismissedWarning: false, lastWrite: 0,
            activityKey: `admin-inactivity-activity:${identity}`,
            logoutKey: `admin-inactivity-logout:${identity}`,
            channel: null, lastActivity: 0
        };
        active = state;
        state.lastActivity = readNumber(state.activityKey);
        if (!state.lastActivity) activity(state, true);
        if (typeof root.BroadcastChannel === 'function') {
            state.channel = new root.BroadcastChannel(`admin-inactivity:${identity}`);
            state.channel.onmessage = event => {
                if (event.data?.type === 'activity' && Number.isFinite(event.data.at)) {
                    if (event.data.at > state.lastActivity) {
                        state.lastActivity = event.data.at;
                        dismissWarning(state);
                    }
                } else if (event.data?.type === 'logout') {
                    void logout(state, 'remote', event.data.reason === 'timeout');
                } else if (event.data?.type === 'config') void reload();
            };
        }
        root.addEventListener('storage', event => {
            if (event.key === state.activityKey) tick(state);
            else if (event.key === state.logoutKey && event.newValue)
                void logout(state, 'remote', event.newValue.startsWith('timeout:'));
            else if (event.key === CONFIG_EVENT_KEY) void reload();
        });
        for (const name of ACTIVITY_EVENTS) {
            root.document.addEventListener(name, event => {
                if (event.isTrusted === false || event.target?.closest?.('#app-feedback-modal')) return;
                activity(state);
            }, { passive: true });
        }
        root.addEventListener('focus', () => tick(state));
        root.document.addEventListener('visibilitychange', () => {
            if (!root.document.hidden) tick(state);
        });
        client.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT' && !state.leaving) {
                let timeoutNotice = false;
                try { timeoutNotice = root.localStorage.getItem(state.logoutKey)?.startsWith('timeout:') || false; }
                catch (_) { /* optional storage */ }
                void logout(state, 'remote', timeoutNotice);
            }
        });
        root.setInterval(() => tick(state), 1000);
        root.setInterval(() => { void reload(); }, 60000);
        tick(state);
        await reload();
    }

    function settingChanged() {
        writeNumber(CONFIG_EVENT_KEY, Date.now());
        active?.channel?.postMessage({ type: 'config' });
        void reload();
    }

    root.AdminInactivity = Object.freeze({ start, reload, settingChanged, validMinutes });
})(window);
