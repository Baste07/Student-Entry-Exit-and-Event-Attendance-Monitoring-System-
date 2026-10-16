const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname,
    '../../TimeInAndTimeOutMonitoring/resc/js/manualAttendance.js'), 'utf8');

function eventCameraPage({ devices = [], failIds = [], cameraError = null,
    startGate = null, withTrack = false } = {}) {
    const attempts = [];
    const instances = [];
    const messages = [];
    let onTrackEnded;
    const video = { srcObject: { getVideoTracks: () => [{
        addEventListener(event, callback) { if (event === 'ended') onTrackEnded = callback; }
    }] } };
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            style: {}, innerHTML: '', className: '',
            querySelector() { return withTrack ? video : null; }
        });
        return elements.get(id);
    };
    const context = vm.createContext({
        window: { location: { search: '' } },
        document: { getElementById: element, addEventListener() {} },
        localStorage: { getItem() { return ''; }, setItem() {} },
        sessionStorage: { getItem() { return null; } },
        PreferredCamera: { async listVideoInputs() {
            if (cameraError) throw new Error(cameraError);
            return devices;
        } },
        Html5Qrcode: class {
            async start(config) {
                const id = config?.deviceId?.exact || config;
                attempts.push(id);
                if (startGate) await startGate;
                if (failIds.includes(id)) throw new Error('Camera busy');
                instances.push(this);
            }
            async stop() { this.stopped = true; }
            async clear() { this.cleared = true; }
        },
        URLSearchParams, setTimeout() { return 1; }, clearTimeout() {}, console
    });
    vm.runInContext(source, context);
    context.showToast = (message, type) => messages.push({ message, type });
    vm.runInContext('qrCameraSession = 1', context);
    return { context, attempts, instances, messages,
        trackEnded() { assert.ok(onTrackEnded); onTrackEnded(); },
        async start() { await vm.runInContext('startScannerWithFallback(() => {}, qrCameraSession)', context); },
        async open() { await vm.runInContext('openQRScanner()', context); } };
}

test('Event QR uses external first, then another external, then built-in if needed', async () => {
    const devices = [
        { id: 'usb-a', type: 'external' }, { id: 'usb-b', type: 'external' },
        { id: 'local', type: 'local' }
    ];
    const page = eventCameraPage({ devices, failIds: ['usb-a', 'usb-b'] });
    await page.start();
    assert.deepEqual(page.attempts.slice(0, 3), ['usb-a', 'usb-a', 'usb-a']);
    assert.deepEqual(page.attempts.slice(3, 6), ['usb-b', 'usb-b', 'usb-b']);
    assert.equal(page.attempts.at(-1), 'local');
    assert.equal(page.instances.length, 1);
    await vm.runInContext('stopScanner()', page.context);
    assert.equal(page.instances[0].stopped, true);
});

test('Event QR starts an available built-in camera instead of waiting for external hardware', async () => {
    const page = eventCameraPage({ devices: [{ id: 'local', type: 'local' }] });
    await page.start();
    assert.deepEqual(page.attempts, ['local']);
    assert.equal(page.instances.length, 1);
});

test('Event QR reports no camera and permission denial without starting streams', async () => {
    const missing = eventCameraPage({ cameraError: 'NO_CAMERA_FOUND' });
    await missing.open();
    assert.equal(missing.attempts.length, 0);
    assert.match(missing.messages.at(-1).message, /Camera Required/);
    const denied = eventCameraPage({ cameraError: 'CAMERA_PERMISSION_DENIED' });
    await denied.open();
    assert.equal(denied.attempts.length, 0);
    assert.match(denied.messages.at(-1).message, /permission blocked/);
});

test('Event QR releases an in-flight camera start when switching away', async () => {
    let releaseStart;
    const gate = new Promise(resolve => { releaseStart = resolve; });
    const page = eventCameraPage({ devices: [{ id: 'usb', type: 'external' }], startGate: gate });
    const starting = page.open();
    await new Promise(setImmediate);
    await vm.runInContext('stopScanner()', page.context);
    releaseStart();
    await starting;
    assert.equal(page.attempts.length, 1);
    assert.equal(page.instances[0].stopped, true);
    assert.equal(vm.runInContext('html5QrCode === null', page.context), true);
});

test('Event QR releases a disconnected camera and offers a retry', async () => {
    const page = eventCameraPage({ devices: [{ id: 'usb', type: 'external' }], withTrack: true });
    await page.open();
    page.trackEnded();
    await new Promise(setImmediate);
    assert.equal(page.instances[0].stopped, true);
    assert.equal(vm.runInContext('html5QrCode === null', page.context), true);
    assert.match(page.messages.at(-1).message, /disconnected.*retry/);
});

test('Event QR stays open when a scheduled Event completes and releases only on Stop', async () => {
    const page = eventCameraPage({ devices: [{ id: 'usb', type: 'external' }] });
    await page.open();
    const ended = { event_id: 'event-a', event_date: '2026-10-15',
        time_start: '08:00:00', time_end: '09:00:00', status: 'completed' };
    const selection = page.context.selectRelevantEvent([ended], new Date('2026-10-15T02:00:00Z'));
    assert.equal(selection.state, 'completed');
    assert.equal(vm.runInContext('isScanning', page.context), true);
    assert.notEqual(page.instances[0].stopped, true);
    assert.equal(page.context.window.location.search, '');
    await vm.runInContext('stopScanner()', page.context);
    assert.equal(page.instances[0].stopped, true);
});
