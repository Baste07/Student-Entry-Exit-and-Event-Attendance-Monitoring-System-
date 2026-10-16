const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../shared/preferred-camera.js'), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const camera = context.window.PreferredCamera;
const input = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });

test('labeled external cameras outrank unknown and integrated cameras', () => {
    const ordered = camera.orderVideoInputs([
        input('internal', 'Integrated HD Camera'), input('unknown', 'Camera'),
        input('usb-a', 'USB Camera'), input('usb-b', 'External Webcam')
    ]);
    assert.deepEqual(ordered.map(device => device.id), ['usb-a', 'usb-b', 'unknown', 'internal']);
    assert.equal(ordered[0].type, 'external');
    assert.equal(ordered.at(-1).type, 'local');
});

test('a built-in camera remains available when no external camera is listed', () => {
    const ordered = camera.orderVideoInputs([input('local', 'Built-in Camera')]);
    assert.deepEqual(ordered.map(device => device.id), ['local']);
});

test('unlabeled cameras trigger one normal permission request then re-enumeration', async () => {
    let enumerations = 0;
    let requests = 0;
    let stops = 0;
    const mediaDevices = {
        async enumerateDevices() {
            enumerations++;
            return enumerations === 1
                ? [input('one', ''), input('two', '')]
                : [input('one', 'Integrated Camera'), input('two', 'USB Webcam')];
        },
        async getUserMedia() {
            requests++;
            return { getTracks: () => [{ stop() { stops++; } }] };
        }
    };
    const ordered = await camera.listVideoInputs(mediaDevices);
    assert.deepEqual(ordered.map(device => device.id), ['two', 'one']);
    assert.deepEqual([enumerations, requests, stops], [2, 1, 1]);
});

test('no camera and denied permission return clear classifications', async () => {
    const noCamera = { enumerateDevices: async () => [],
        getUserMedia: async () => { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); } };
    const denied = { enumerateDevices: async () => [input('unknown', '')],
        getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } };
    await assert.rejects(camera.listVideoInputs(noCamera), /NO_CAMERA_FOUND/);
    await assert.rejects(camera.listVideoInputs(denied), /CAMERA_PERMISSION_DENIED/);
});
