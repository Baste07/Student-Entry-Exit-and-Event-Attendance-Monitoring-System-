const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../admin/usermanagement.js'), 'utf8');
const currentAdmin = { id: 'self', userType: 'admin', adminLevel: 'super_admin' };
const fixtures = [
    { id: 'self', name: 'Current Admin', email: 'self@example.test', faculty: 'Science', level: 'super_admin', status: 'active' },
    { id: 'target', name: "Sam O'Neil", email: 'target@example.test', faculty: 'Science', level: 'admin', status: 'active' },
    { id: 'remaining', name: 'Sam Remaining', email: 'remaining@example.test', faculty: 'Science', level: 'admin', status: 'active' },
    { id: 'suspended', name: 'Sam Suspended', email: 'suspended@example.test', faculty: 'Science', level: 'admin', status: 'suspended' }
];

// Only the DOM surface used by table rendering; no scripts or inline handlers run.
class Element {
    constructor() {
        this.children = [];
        this.dataset = {};
        this.classList = { add() {} };
        this.listeners = {};
    }

    set innerHTML(value) {
        this.html = value;
        this.children = [];
        const markup = value.match(/<button\b[^>]*class="[^"]*\bbtn-delete-admin\b[^"]*"[^>]*>/s)?.[0];
        this.deleteButton = markup ? new Element() : null;
        if (this.deleteButton) {
            this.deleteButton.markup = markup;
            this.deleteButton.disabled = /\sdisabled(?:\s|>|=)/.test(markup);
        }
    }

    querySelector(selector) { return selector === '.btn-delete-admin' ? this.deleteButton : null; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    appendChild(child) { this.children.push(child); }
}

function harness(options = {}) {
    const nodes = Object.fromEntries(['adminsTableBody', 'totalAdminsCount', 'superAdminCount', 'regularAdminCount']
        .map(id => [id, new Element()]));
    const filters = {
        '.search-input': { value: options.search || '' },
        '.level-filter': { value: options.level || 'All Levels' },
        '.status-filter': { value: options.status || 'All Statuses' }
    };
    const requests = [];
    const alerts = [];
    const confirmations = [];
    const authCalls = [];
    const user = options.user || currentAdmin;
    const authResult = options.authResult || { data: { session: { access_token: 'test-token', user: { id: 'self' } } }, error: null };
    const context = vm.createContext({
        document: {
            addEventListener() {},
            createElement() { return new Element(); },
            getElementById(id) { return nodes[id] || null; },
            querySelector(selector) { return filters[selector] || null; }
        },
        sessionStorage: { getItem() { return JSON.stringify(user); } },
        console: { error() {} },
        alert(message) { alerts.push(message); },
        confirm(message) { confirmations.push(message); return options.confirm !== false; },
        supabaseClient: {
            auth: { async getSession() { authCalls.push(true); return authResult; } }
        },
        async fetch(url, init) {
            requests.push({ url, init });
            return options.fetch ? options.fetch(url, init) : { ok: true, async json() { return { success: true }; } };
        },
        fixtureAdmins: structuredClone(options.admins || fixtures)
    });
    vm.runInContext(source, context, { filename: 'usermanagement.js' });
    vm.runInContext('allAdmins = fixtureAdmins; initializeUserSession(); updateStatistics(); applyFilters();', context);
    return {
        context, nodes, filters, requests, alerts, confirmations, authCalls,
        rows: () => nodes.adminsTableBody.children,
        button: id => nodes.adminsTableBody.children.find(row => row.dataset.adminId === id)?.deleteButton,
        ids: () => Array.from(vm.runInContext('allAdmins.map(admin => admin.id)', context)),
        pending: () => vm.runInContext('pendingAdminDeletions.size', context)
    };
}

test('regular admins and the current account cannot be deleted through the handler', async () => {
    for (const options of [{ user: { ...currentAdmin, adminLevel: 'admin' } }, { user: { userType: 'admin', adminLevel: 'super_admin' } }]) {
        const app = harness(options);
        await app.context.deleteAdmin('target');
        assert.equal(app.requests.length, 0);
        assert.equal(app.confirmations.length, 0);
        assert.match(app.alerts[0], /Only Super Admins/);
        assert.equal(app.button('target'), null);
    }
    const app = harness();
    await app.context.deleteAdmin('self');
    assert.equal(app.requests.length, 0);
    assert.equal(app.confirmations.length, 0);
    assert.match(app.alerts[0], /own account/);
    assert.equal(app.button('self'), null);
});

test('canceling confirmation preserves the account without requesting a session or deletion', async () => {
    const app = harness({ confirm: false });
    await app.context.deleteAdmin('target');
    assert.match(app.confirmations[0], /Sam O'Neil/);
    assert.equal(app.authCalls.length, 0);
    assert.equal(app.requests.length, 0);
    assert.equal(app.pending(), 0);
    assert.equal(app.button('target').disabled, false);
    assert.ok(app.ids().includes('target'));
});

test('missing, expired, and mismatched Auth sessions prevent deletion and permit retry', async () => {
    const invalidSessions = [
        { data: { session: null }, error: null },
        { data: { session: null }, error: new Error('Session expired') },
        { data: { session: { access_token: 'wrong-token', user: { id: 'someone-else' } } }, error: null }
    ];
    for (const authResult of invalidSessions) {
        const app = harness({ authResult });
        await app.context.deleteAdmin('target');
        assert.equal(app.requests.length, 0);
        assert.ok(app.ids().includes('target'));
        assert.match(app.alerts[0], /sign in again|Session expired/);
        assert.equal(app.pending(), 0);
        assert.equal(app.button('target').disabled, false);
    }
});

test('a pending deletion disables its button and rejects duplicate submissions', async () => {
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const app = harness({ fetch: () => response });
    const deletion = app.context.deleteAdmin('target');
    await Promise.resolve();
    assert.equal(app.pending(), 1);
    assert.equal(app.button('target').disabled, true);
    await app.context.deleteAdmin('target');
    assert.equal(app.confirmations.length, 1);
    assert.equal(app.requests.length, 1);
    finish({ ok: true, async json() { return { success: true }; } });
    await deletion;
    assert.equal(app.pending(), 0);
    assert.equal(app.button('target'), undefined);
});

test('clicking delete handles apostrophes, sends authenticated ID, and retains active filters after success', async () => {
    const app = harness({ search: 'Sam', level: 'admin', status: 'active' });
    assert.deepEqual(app.rows().map(row => row.dataset.adminId), ['target', 'remaining']);
    const button = app.button('target');
    assert.doesNotMatch(button.markup, /onclick|Sam|O'Neil/);
    assert.equal(typeof button.listeners.click, 'function');
    await button.listeners.click();

    assert.equal(app.requests.length, 1);
    const { url, init } = app.requests[0];
    assert.equal(url, 'delete-admin.php');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { adminId: 'target' });
    assert.deepEqual(app.ids(), ['self', 'remaining', 'suspended']);
    assert.deepEqual(app.rows().map(row => row.dataset.adminId), ['remaining']);
    assert.equal(app.nodes.totalAdminsCount.textContent, 3);
    assert.equal(app.nodes.superAdminCount.textContent, 1);
    assert.equal(app.nodes.regularAdminCount.textContent, 2);
    assert.equal(app.filters['.search-input'].value, 'Sam');
    assert.equal(app.filters['.level-filter'].value, 'admin');
    assert.equal(app.filters['.status-filter'].value, 'active');
    assert.match(app.alerts[0], /"Sam O'Neil" has been deleted/);
});

test('API rejection keeps the account and statistics and enables a successful retry', async () => {
    let attempts = 0;
    const app = harness({
        fetch: async () => ++attempts === 1
            ? { ok: false, async json() { return { success: false, message: 'Account is still referenced.' }; } }
            : { ok: true, async json() { return { success: true }; } }
    });
    await app.context.deleteAdmin('target');
    assert.ok(app.ids().includes('target'));
    assert.equal(app.nodes.totalAdminsCount.textContent, 4);
    assert.equal(app.button('target').disabled, false);
    assert.equal(app.pending(), 0);
    assert.equal(app.alerts[0], 'Account is still referenced.');
    await app.button('target').listeners.click();
    assert.equal(attempts, 2);
    assert.equal(app.ids().includes('target'), false);
});

test('delete controls are available for another super admin but absent for regular operators', () => {
    const admins = [...fixtures, { ...fixtures[0], id: 'other-super' }];
    const superApp = harness({ admins });
    assert.ok(superApp.button('other-super'));
    const regularApp = harness({ admins, user: { ...currentAdmin, adminLevel: 'admin' } });
    assert.equal(regularApp.rows().some(row => row.deleteButton), false);
});
