const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const qr = `student_uuid:${uuid}`;

function loadBrowserScript(relativePath) {
    const context = {
        window: { location: { search: '' } },
        sessionStorage: { getItem: () => null },
        document: { addEventListener() {}, getElementById: () => null },
        URLSearchParams, console, setTimeout, clearTimeout
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context);
    return context;
}

const importer = loadBrowserScript('admin/student-import.js');
assert.equal(importer.getStudentQrPayload({ studentUuid: uuid, studId: '1-0001' }), qr);
assert.throws(() => importer.getStudentQrPayload({ studId: '1-0001' }), /UUID is required/);

const event = loadBrowserScript('TimeInAndTimeOutMonitoring/resc/js/manualAttendance.js');
assert.equal(event.extractIdFromQr(qr), qr);
assert.equal(event.extractIdFromQr('Student ID: 10-0025'), '10-0025');
assert.equal(event.isValidDetectedId(qr), true);

const gate = require('../../EntryExitMonitoring/resc/js/qrAttendance.js');
assert.deepEqual(gate.extractGateQrId(qr), { id: qr, role: 'student' });
assert.deepEqual(gate.extractGateQrId('Student ID: K-0001'), { id: 'K-0001', role: 'student' });
assert.equal(gate.extractGateQrId('unrelated text'), null);

console.log('Student rollover QR parsing checks passed.');
