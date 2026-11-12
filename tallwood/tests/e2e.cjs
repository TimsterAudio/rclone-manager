// End-to-end test: drives the real UI against the real backend in browser mode.
//   cargo build --no-default-features && node tests/e2e.cjs [--shots DIR]
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bin = process.env.TALLWOOD_BIN || path.join(__dirname, '..', 'target', 'debug', os.platform() === 'win32' ? 'tallwood.exe' : 'tallwood');
const shotsAt = process.argv.indexOf('--shots');
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const PORT = 7791;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tallwood-e2e-'));
  const w = (rel, body = rel) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('docs/alpha.txt', 'Alpha file\nsecond line\n');
  w('docs/beta.txt', 'Beta');
  w('docs/gamma.md', '# Gamma\n');
  w('docs/data.bin', Buffer.from([0, 1, 2, 3, 255, 254]));
  w('docs/reports/q1.csv', 'a,b\n1,2\n');
  w('docs/reports/q2.csv', 'a,b\n3,4\n');
  w('backup/beta.txt', 'Old beta');
  w('src/main.rs', 'fn main() {}\n');
  w('src/lib/util.rs', '// util\n');
  w('.hidden/secret.txt', 'x');
  fs.mkdirSync(path.join(root, 'empty'));
  return root;
}

(async () => {
  const root = fixture();
  const cfg = path.join(root, '..', `${path.basename(root)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ trash: false }));
  const server = spawn(bin, ['--serve', String(PORT), root], {
    env: { ...process.env, TALLWOOD_TOKEN: 'test-token', TALLWOOD_CONFIG: cfg },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('running at') && resolve());
    server.on('exit', c => reject(new Error(`server exited ${c}`)));
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: shots ? 2 : 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));

  const key = k => page.keyboard.press(k);
  const names = sel => page.$$eval(sel, rows => rows.map(r => r.querySelector('.c-name').textContent.trim()));
  const files = (pane = 0) => names(`#pane-${pane} .files .row`);
  const tree = (pane = 0) => names(`#pane-${pane} .tree .row`);
  const stat = async label => {
    const t = await page.$eval('#stats', el => el.innerText);
    return t.split(label)[1].trim().split('\n')[0];
  };
  const dialog = () => page.locator('.modal');
  const settle = () => page.waitForTimeout(250);
  const shot = async name => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));
  let step = 0;
  const check = (label, cond, detail = '') => {
    step++;
    assert.ok(cond, `${label} ${detail}`);
    console.log(`  ok ${step} - ${label}`);
  };

  try {
    // Unauthenticated calls are refused.
    const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, { method: 'POST', body: '{"method":"init"}' });
    check('rpc without token is refused', res.status === 403);

    await page.goto(`http://127.0.0.1:${PORT}/?t=test-token`);
    await page.waitForSelector('body.ready');
    check('tree lists folders, hides dot-folders', JSON.stringify((await tree()).slice(1)) === JSON.stringify(['backup', 'docs', 'empty', 'src']), JSON.stringify(await tree()));

    // Tree navigation.
    await key('ArrowDown');
    await key('ArrowDown');
    await settle();
    check('file window follows the tree cursor', JSON.stringify(await files()) === JSON.stringify(['alpha.txt', 'beta.txt', 'data.bin', 'gamma.md']), JSON.stringify(await files()));
    await key('ArrowRight');
    await settle();
    check('right arrow expands', (await tree()).includes('reports'));
    await key('ArrowLeft');
    await settle();
    check('left arrow collapses', !(await tree()).includes('reports'));

    // Second pane to backup.
    await key('Tab');
    await key('ArrowDown');
    await settle();
    check('tab switches pane', (await page.$eval('#pane-1', el => el.classList.contains('active'))) && (await files(1)).join() === 'beta.txt');
    await key('Tab');

    // Tagging and statistics.
    await key('Enter');
    await key('t');
    await key('Space');
    await settle();
    check('T and Space tag files', (await stat('Tagged')).startsWith('2 files'), await stat('Tagged'));
    await shot('01-main');

    // Command bar reacts to modifiers.
    await page.keyboard.down('Control');
    check('command bar shows Ctrl commands', (await page.$eval('#cmdbar', el => el.innerText)).includes('CTRL FILE'));
    await page.keyboard.up('Control');

    // Copy tagged to the other pane, with a conflict.
    await key('Control+c');
    await dialog().waitFor();
    check('copy defaults to the other pane', (await page.inputValue('.modal input[data-field=to]')) === path.join(root, 'backup'));
    await shot('02-copy');
    await key('Enter');
    await page.waitForSelector('.modal:has-text("Already in the destination")');
    await shot('03-conflict');
    await key('k'); // Keep both
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await settle();
    check('copy with keep-both', fs.readFileSync(path.join(root, 'backup', 'beta (2).txt'), 'utf8') === 'Beta' && fs.readFileSync(path.join(root, 'backup', 'beta.txt'), 'utf8') === 'Old beta' && fs.existsSync(path.join(root, 'backup', 'alpha.txt')));
    check('other pane refreshed', (await files(1)).join() === 'alpha.txt,beta (2).txt,beta.txt', (await files(1)).join());

    // Filespec.
    await key('f');
    await dialog().waitFor();
    await page.keyboard.type('*.txt');
    await key('Enter');
    await settle();
    check('filespec filters', (await files()).join() === 'alpha.txt,beta.txt' && (await stat('Matching')).startsWith('2 files'));
    await key('f');
    await dialog().waitFor();
    await key('Backspace');
    await key('Enter');
    await settle();
    check('empty filespec resets', (await files()).length === 4);

    // Branch and Showall.
    await key('b');
    await page.waitForSelector('#pane-0.flat');
    check('branch lists files below', (await files()).join() === 'alpha.txt,beta.txt,data.bin,gamma.md,q1.csv,q2.csv', (await files()).join());
    await shot('04-branch');
    await key('Escape');
    await key('s');
    await page.waitForSelector('#pane-0.flat');
    check('showall lists every logged file', (await files()).length === 11, String((await files()).length));
    await key('Escape');
    await settle();

    // Viewer.
    await key('Enter');
    await key('Home');
    await key('v');
    await page.waitForSelector('.modal.full pre');
    check('viewer shows text', (await page.textContent('.modal.full pre')).includes('second line'));
    await key('h');
    check('viewer hex mode', (await page.textContent('.modal.full pre')).includes('41 6c 70 68 61'));
    await shot('05-viewer');
    await key('Escape');

    // Rename.
    await key('F2');
    await dialog().waitFor();
    await page.keyboard.type('alpha-renamed.txt');
    await key('Enter');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await settle();
    check('rename', fs.existsSync(path.join(root, 'docs', 'alpha-renamed.txt')) && (await files())[0] === 'alpha-renamed.txt');

    // Batch rename.
    await key('Control+t');
    await key('Control+r');
    await dialog().waitFor();
    await page.keyboard.type('doc-{n:2}.*');
    await settle();
    check('batch rename previews', (await page.textContent('.modal .preview-text')).includes('alpha-renamed.txt  →  doc-01.txt'));
    await shot('06-batch-rename');
    await key('Enter');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await settle();
    check('batch rename applies', (await files()).join() === 'doc-01.txt,doc-02.txt,doc-03.bin,doc-04.md', (await files()).join());

    // Delete (permanent mode needs the explicit letter, Enter must not confirm).
    await key('d');
    await dialog().waitFor();
    await key('Enter');
    await settle();
    check('Enter cancels a permanent delete', fs.existsSync(path.join(root, 'docs', 'doc-01.txt')) && (await dialog().count()) === 0);
    await key('d');
    await dialog().waitFor();
    await key('d');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await settle();
    check('delete', !fs.existsSync(path.join(root, 'docs', 'doc-01.txt')) && (await files()).length === 3);

    // Makedir from the tree.
    await key('Escape');
    await key('m');
    await dialog().waitFor();
    await page.keyboard.type('new/nested');
    await key('Enter');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await settle();
    check('makedir creates nested folders', fs.statSync(path.join(root, 'docs', 'new', 'nested')).isDirectory() && (await tree()).includes('new'));

    // Compare panes.
    await key('c');
    await dialog().waitFor();
    await key('Enter'); // Unique
    await settle();
    check('compare tags unique files on both sides', (await page.$$eval('.row.tagged', r => r.length)) === 6, String(await page.$$eval('.row.tagged', r => r.length)));
    await key('Control+u');

    // Move with paths out of a branch.
    await key('b');
    await page.waitForSelector('#pane-0.flat');
    await key('f');
    await dialog().waitFor();
    await page.keyboard.type('*.csv');
    await key('Enter');
    await settle();
    await key('Control+t');
    await key('Alt+m');
    await dialog().waitFor();
    await key('Enter');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await settle();
    check('move with paths recreates folders', fs.existsSync(path.join(root, 'backup', 'reports', 'q1.csv')) && !fs.existsSync(path.join(root, 'docs', 'reports', 'q1.csv')));
    await key('f');
    await dialog().waitFor();
    await key('Backspace');
    await key('Enter');
    await key('Escape');
    await settle();

    // Hidden files, autoview, split, themes, palette, help.
    await key('Control+h');
    await settle();
    check('hidden toggle', (await tree()).includes('.hidden'));
    await key('Control+h');
    await settle();
    await key('F7');
    await page.waitForSelector('#preview .view-body');
    check('autoview previews the current file', (await page.isVisible('#preview')) && !(await page.isVisible('#pane-1')));
    await shot('07-autoview');
    await key('F7');
    await key('F8');
    await settle();
    check('F8 unsplits', !(await page.isVisible('#pane-1')));
    await key('F8');
    await key('F9');
    await dialog().waitFor();
    await page.keyboard.type('sort');
    await settle();
    check('palette filters commands', (await page.textContent('.pick-item.cur')).includes('Sort'));
    await shot('08-palette');
    await key('Escape');
    await key('F1');
    await dialog().waitFor();
    await shot('09-help');
    await key('Escape');
    await key('F10');
    await settle();
    check('F10 switches theme', (await page.getAttribute('html', 'data-theme')) === 'classic');
    await key('Escape');
    await key('ArrowRight');
    await settle();
    await shot('10-classic');
    await key('F10');
    await settle();
    await shot('11-paper');

    // Log a different root.
    await key('l');
    await dialog().waitFor();
    await page.keyboard.type(path.join(root, 'src'));
    await key('Enter');
    await settle();
    check('log re-roots the pane', (await tree())[0] === path.join(root, 'src') && (await tree()).includes('lib'), JSON.stringify(await tree()));

    await page.waitForTimeout(800);
    check('settings are saved', JSON.parse(fs.readFileSync(cfg, 'utf8')).theme === 'paper');
    check('no console errors', errors.length === 0, errors.join('\n'));
    console.log(`\nall ${step} checks passed`);
  } catch (e) {
    if (shots) await page.screenshot({ path: path.join(shots, 'failure.png') });
    console.error(`\nFAILED: ${e.message}`);
    if (errors.length) console.error(errors.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cfg, { force: true });
  }
})();
