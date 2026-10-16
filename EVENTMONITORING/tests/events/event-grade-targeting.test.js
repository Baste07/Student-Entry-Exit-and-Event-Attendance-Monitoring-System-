const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/events.js'), 'utf8');
const targets = require(path.join(root, 'shared/event-targets.js'));
const migration = fs.readFileSync(path.join(root, 'database/migrations/20261016_event_grade_section_targets.sql'), 'utf8');
const year = '00000000-0000-4000-8000-000000000001';
const sectionA = '00000000-0000-4000-8000-000000000011';
const sectionB = '00000000-0000-4000-8000-000000000012';
const sectionG2 = '00000000-0000-4000-8000-000000000021';
const otherYearSection = '00000000-0000-4000-8000-000000000031';

function page() {
    const elements = new Map();
    const calls = [];
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', innerHTML: '', textContent: '', checked: false, style: {},
            classList: { add() {}, remove() {}, contains() { return false; } },
            setAttribute() {}, removeAttribute() {}, scrollIntoView() {},
            querySelectorAll() { return []; },
            querySelector() { return { disabled: false, innerHTML: '' }; },
            addEventListener(type, handler) { if (id === 'eventForm' && type === 'submit') this.submit = handler; },
        });
        return elements.get(id);
    };
    const client = {
        rpc: async (name, args) => { calls.push({ kind: 'rpc', name, args }); return { data: name === 'save_grade_targeted_event' ? 'event-new' : [], error: null }; },
        from: name => ({
            update: value => ({ eq: async () => { calls.push({ kind: 'update', name, value }); return { error: null }; } }),
        }),
    };
    const context = vm.createContext({
        document: {
            getElementById: element, querySelectorAll: () => [], addEventListener() {},
            body: { style: {} },
        },
        supabaseClient: client, EventTargets: targets,
        UIFeedback: { error: message => calls.push({ kind: 'error', message }) },
        setInterval() {}, console,
    });
    vm.runInContext(source, context);
    vm.runInContext(`
        applicableSchoolYear = { id: '${year}' };
        allSectionsData = [
            { section_id: '${sectionA}', grade_level: 'Grade 1', school_year_id: '${year}', section_name: 'A' },
            { section_id: '${sectionB}', grade_level: 'Grade 1', school_year_id: '${year}', section_name: 'B' },
            { section_id: '${sectionG2}', grade_level: 'Grade 2', school_year_id: '${year}', section_name: 'C' },
            { section_id: '${otherYearSection}', grade_level: 'Grade 1', school_year_id: 'other-year', section_name: 'Other' }
        ];
    `, context);
    return { context, element, calls, client };
}

test('new grade defaults to All Sections, then accepts multiple UUID sections in its own grade/year', () => {
    const { context } = page();
    vm.runInContext(`toggleGrade('Grade 1')`, context);
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context)), [
        { grade_level: 'Grade 1', all_sections: true, section_ids: [] },
    ]);
    vm.runInContext(`toggleGradeSection('Grade 1','${sectionA}',true); toggleGradeSection('Grade 1','${sectionB}',true)`, context);
    const rules = JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context));
    assert.deepEqual(rules[0].section_ids, [sectionA, sectionB]);
    vm.runInContext(`toggleGradeSection('Grade 1','${sectionG2}',true); toggleGradeSection('Grade 1','${otherYearSection}',true)`, context);
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context))[0].section_ids, [sectionA, sectionB]);
});

test('Select All Grades defaults every grade to All Sections and permits overrides', () => {
    const { context } = page();
    vm.runInContext(`toggleGrade('Grade 1'); toggleGradeSection('Grade 1','${sectionA}',true); toggleAllGrades()`, context);
    let rules = JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context));
    assert.equal(rules.length, 11);
    assert.equal(rules.find(rule => rule.grade_level === 'Grade 1').all_sections, true);
    vm.runInContext(`toggleGradeSection('Grade 1','${sectionA}',true)`, context);
    rules = JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context));
    assert.deepEqual(rules.find(rule => rule.grade_level === 'Grade 1').section_ids, [sectionA]);
    assert.equal(rules.find(rule => rule.grade_level === 'Grade 2').all_sections, true);
    vm.runInContext(`toggleGrade('Grade 2')`, context);
    rules = JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context));
    assert.equal(rules.length, 10);
    assert.equal(rules.some(rule => rule.grade_level === 'Grade 2'), false);
});

test('new normalized grade Event uses only atomic save RPC and no independent table writes', async () => {
    const { context, element, calls } = page();
    const values = {
        eventId: '', eventName: 'New Event', eventDate: '2026-11-01', eventEndDate: '',
        eventType: 'assembly', timeStart: '09:00', timeEnd: '10:00',
        location: 'Hall', description: '', participantMode: 'grade',
    };
    for (const [id, value] of Object.entries(values)) element(id).value = value;
    element('isMultiDay').checked = false;
    vm.runInContext(`selectedGrades.add('Grade 1'); gradeSectionTargets.set('Grade 1',null);
        validateLive = () => true; clearValidationError = () => {}; hideOverlapWarning = () => {};
        closeModal = () => {}; loadEvents = async () => {}; showToast = () => {};
        getManilaNow = () => new Date('2026-10-16T09:00:00');`, context);
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    const saves = calls.filter(call => call.name === 'save_grade_targeted_event');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].args.p_school_year_id, year);
    assert.equal(saves[0].args.p_targets[0].all_sections, true);
    assert.equal(calls.some(call => call.kind === 'update'), false);
    assert.equal(calls.some(call => call.kind === 'error'), false);
});

test('editing a normalized Event restores grade, section UUIDs, and grade mode even with a roster', async () => {
    const { context, element } = page();
    vm.runInContext(`
        allEvents = [{event_id:'event-1', event_name:'Existing', event_date:'2026-11-01',
            normalizedTargets:[{school_year_id:'${year}', grade_level:'Grade 1',
                all_sections:false,event_grade_target_sections:[{section_id:'${sectionA}'}]}]}];
        loadGradeLevels = async () => {};
        loadEventParticipants = async () => { currentEventParticipants = [{student_id:'student-1'}]; };
    `, context);
    await vm.runInContext(`editEvent('event-1')`, context);
    assert.equal(element('participantMode').value, 'grade');
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(getNormalizedRules())', context)), [
        { grade_level: 'Grade 1', all_sections: false, section_ids: [sectionA] },
    ]);
});

test('legacy grade Event with participant rows stays grade mode and preserves its roster on metadata edit', async () => {
    const { context, element, calls } = page();
    vm.runInContext(`
        allEvents = [{event_id:'event-old', event_name:'Legacy', event_date:'2026-11-01',
            target_grade_level:'Grade 1',target_section:'Historical section',normalizedTargets:[]}];
        loadGradeLevels = async () => {};
        loadEventParticipants = async () => { currentEventParticipants = [{student_id:'student-1'}]; };
        validateLive = () => true; clearValidationError = () => {}; hideOverlapWarning = () => {};
        closeModal = () => {}; loadEvents = async () => {}; showToast = () => {};
        getManilaNow = () => new Date('2026-10-16T09:00:00');
    `, context);
    await vm.runInContext(`editEvent('event-old')`, context);
    assert.equal(element('participantMode').value, 'grade');
    element('eventType').value = 'assembly';
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    assert.deepEqual(calls.filter(call => call.kind === 'update').map(call => call.name), ['events']);
    assert.equal(calls.some(call => call.name === 'save_grade_targeted_event'), false);
});

test('normalized summary prefers section names; legacy fallback remains readable', () => {
    const event = { target_grade_level: 'Grade 10', target_section: 'Old Section', normalizedTargets: [
        { grade_level: 'Grade 1', all_sections: false, event_grade_target_sections: [
            { sections: { section_name: 'A' } }, { sections: { section_name: 'B' } },
        ] },
        { grade_level: 'Grade 2', all_sections: true, event_grade_target_sections: [] },
    ] };
    assert.equal(targets.summary(event), 'Grade 1: A, B; Grade 2: All Sections');
    assert.equal(targets.summary({ target_grade_level: 'Grade 1', target_section: 'Legacy' }), 'Grade 1: Legacy');
});

test('migration preserves attended links and keeps completed Events out of automatic sync', () => {
    assert.match(migration, /delete from public\.event_participants ep[\s\S]*?not exists \(\s*select 1 from public\.event_attendance ea/);
    assert.match(migration, /where e\.status in \('scheduled','upcoming','ongoing'\)/);
    assert.match(migration, /create function public\.preview_event_grade_participants\([\s\S]*?p_event_id uuid default null/);
});
