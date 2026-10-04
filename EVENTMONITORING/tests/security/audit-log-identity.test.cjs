const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../..', 'admin', 'audit-logs.html'), 'utf8');
const start = html.indexOf('function auditIdentityValue(');
const end = html.indexOf('function getFilteredEntries()', start);
assert(start >= 0 && end > start);
const context = { Date, Map, Set, console };
vm.createContext(context);
vm.runInContext(html.slice(start, end), context);

const actorId = '11111111-1111-4111-8111-111111111111';
const profile = { admin_id: actorId, admin_name: 'Admin One',
    email: 'one@example.com', admin_level: 'super_admin' };

test('a UUID-only LOGIN resolves from its Admin profile and groups with MFA/page actions', () => {
    const logs = [
        { id: 'login', user_id: actorId, action: 'LOGIN', created_at: '2026-10-04T01:00:00Z' },
        { id: 'mfa', user_id: actorId, action: 'MFA_ENROLLED', created_at: '2026-10-04T01:01:00Z' },
        { id: 'page', user_id: actorId, action: 'PAGE_ACCESS', created_at: '2026-10-04T01:02:00Z' }
    ];
    const resolved = context.resolveAuditLogActors(logs, [profile]);
    const groups = context.buildSessionGroups(resolved);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].userLabel, 'Admin One');
    assert.equal(groups[0].email, 'one@example.com');
    assert.equal(groups[0].role, 'super_admin');
    assert.equal(groups[0].totalActions, 3);
});

test('stored snapshots identify removed Admins without inventing an identity', () => {
    const logs = [
        { id: 'login', user_id: actorId, action: 'LOGIN', created_at: '2026-10-04T01:00:00Z' },
        { id: 'page', user_id: actorId, full_name: 'Former Admin',
            email: 'former@example.com', role: 'admin', action: 'PAGE_ACCESS',
            created_at: '2026-10-04T01:01:00Z' }
    ];
    const resolved = context.resolveAuditLogActors(logs, []);
    assert.equal(resolved[0].full_name, 'Former Admin');
    assert.equal(resolved[0].email, 'former@example.com');
    assert.equal(resolved[0].role, 'admin');
    const trulyUnidentified = context.resolveAuditLogActors([
        { id: 'other', user_id: '22222222-2222-4222-8222-222222222222', action: 'LOGIN' }
    ], []);
    assert.equal(trulyUnidentified[0].full_name, null);
});

test('pre-authentication events remain unknown; explicit automatic and local actors are labeled', () => {
    const logs = context.resolveAuditLogActors([
        { id: 'failed', user_id: null, action: 'LOGIN_FAILED' },
        { id: 'cron', user_id: null, action: 'STUDENT_ID_ROLLOVER', details: { mode: 'automatic' } },
        { id: 'gate', user_id: null, action: 'LOCAL_GATE_EVENT', details: { actor_type: 'local_gate' } }
    ], []);
    assert.equal(logs[0].full_name, null);
    assert.equal(logs[1].full_name, 'System');
    assert.equal(logs[2].full_name, 'Local Gate');
    assert.equal(logs[2].role, 'Local Service');
});

test('audit row text is escaped before insertion into HTML', () => {
    assert.equal(context.escapeAuditHtml('<img src=x onerror="bad">'),
        '&lt;img src=x onerror=&quot;bad&quot;&gt;');
});

test('audit page looks up UUIDs through Admin profiles before rendering groups', async () => {
    const loadStart = html.indexOf('async function loadAuditLogs()');
    const loadEnd = html.indexOf("document.addEventListener('DOMContentLoaded'", loadStart);
    assert(loadStart >= 0 && loadEnd > loadStart);
    let queriedIds;
    let rendered = false;
    const moduleSelect = { value: 'all', innerHTML: '' };
    context.auditState = { logs: [] };
    context.document = { getElementById: id => id === 'auditModuleFilter' ? moduleSelect : null };
    context.renderAuditLogs = () => { rendered = true; };
    context.supabaseClient = {
        from(table) {
            if (table === 'system_audit_logs') return {
                select() { return this; }, order() { return this; },
                async limit() { return { data: [{ id: 'login', user_id: actorId, action: 'LOGIN', module_name: 'auth' }], error: null }; }
            };
            assert.equal(table, 'admins');
            return {
                select() { return this; },
                async in(column, ids) {
                    assert.equal(column, 'admin_id');
                    queriedIds = ids;
                    return { data: [profile], error: null };
                }
            };
        }
    };
    vm.runInContext(html.slice(loadStart, loadEnd), context);
    await context.loadAuditLogs();
    assert.equal(queriedIds[0], actorId);
    assert.equal(context.auditState.logs[0].full_name, 'Admin One');
    assert.equal(context.auditState.logs[0].email, 'one@example.com');
    assert.equal(rendered, true);
});
