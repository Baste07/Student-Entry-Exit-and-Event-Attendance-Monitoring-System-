// Build a rollback-only, isolated-schema SQL regression fixture from the
// exact migration under review. Never point this at Production.
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../..');
const workspaceRoot = path.resolve(moduleRoot, '..');
const migrationPath = path.join(moduleRoot, 'database/migrations/20261016_event_grade_section_targets.sql');
const outputPath = path.join(workspaceRoot, '.artifacts/event-grade-targets-rollback-test.sql');
const prefix = fs.readFileSync(path.join(__dirname, 'grade-targets-fixture-prefix.sql'), 'utf8');
const assertions = fs.readFileSync(path.join(__dirname, 'grade-targets-assertions.sql'), 'utf8');
let migration = fs.readFileSync(migrationPath, 'utf8');

if (!/^begin;\s*$/m.test(migration) || !/^commit;\s*$/m.test(migration)) {
    throw new Error('Expected one transactional migration with BEGIN and COMMIT.');
}
migration = migration.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
migration = migration.replace(/public\./g, 'codex_event_target_test.')
    .replace(/app_private\./g, 'codex_event_target_private.');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, [prefix, migration, assertions].join('\n'));
console.log('Built ignored rollback fixture:', outputPath);
