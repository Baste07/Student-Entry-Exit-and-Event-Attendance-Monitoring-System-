const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../../config/config.js'), 'utf8');

function load(mode) {
    const styles = [];
    const document = {
        currentScript: { src: 'https://school.example/EVENTMONITORING/config/config.js' },
        documentElement: { dataset: {}, style: {} },
        head: { appendChild: item => styles.push(item) },
        createElement: () => ({ textContent: '' }),
        addEventListener: () => {}
    };
    const window = { location: { pathname: '/EVENTMONITORING/auth/login.html' } };
    vm.runInNewContext(script, {
        window, document, URL, console,
        ENV: { SUPABASE_PROJECT_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'public', DEPLOYMENT_MODE: mode }
    });
    return { window, document, styles };
}

test('WEB mode hides local controls and resolves the application root from the script', () => {
    const { window, document, styles } = load('WEB');
    const controls = [{ hidden: false }, { hidden: false }];
    window.AppDeployment.applyNavigation({ querySelectorAll: () => controls });
    assert.equal(window.AppDeployment.isWeb, true);
    assert.equal(window.AppDeployment.root.pathname, '/EVENTMONITORING/');
    assert.equal(document.documentElement.dataset.deploymentMode, 'WEB');
    assert.ok(controls.every(control => control.hidden));
    assert.match(styles[0].textContent, /data-local-operation/);
});

test('LOCAL_GATE keeps scanner controls available', () => {
    const { window, styles } = load('LOCAL_GATE');
    const control = { hidden: false };
    window.AppDeployment.applyNavigation({ querySelectorAll: () => [control] });
    assert.equal(window.AppDeployment.isLocalGate, true);
    assert.equal(control.hidden, false);
    assert.equal(styles.length, 0);
});
