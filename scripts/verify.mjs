#!/usr/bin/env node
/**
 * Verifies a published hachiware-pet tarball end to end, from the registry —
 * not from this working tree.
 *
 *   npm run verify            # latest on npm
 *   npm run verify -- 0.2.2   # a specific version
 *   node scripts/verify.mjs 0.2.2 --registry https://registry.npmjs.org
 *
 * Layers: checksum → package contents → host half → native shell (macOS).
 * Nothing is installed and nothing is written outside a temp directory.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const registryFlag = args.indexOf('--registry');
const registry = registryFlag >= 0 ? args[registryFlag + 1] : 'https://registry.npmjs.org';
const wanted = args.find((a) => /^\d/.test(a)) || 'latest';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const sha1 = (file) => createHash('sha1').update(readFileSync(file)).digest('hex');

const work = mkdtempSync(path.join(tmpdir(), 'hachiware-verify-'));
const cleanup = () => rmSync(work, { recursive: true, force: true });
process.on('exit', cleanup);

// 1. metadata
const meta = await (await fetch(`${registry}/hachiware-pet/${wanted === 'latest' ? 'latest' : wanted}`)).json();
const version = meta.version;
const dist = meta.dist || {};
console.log(`\nhachiware-pet@${version} (${registry})\n`);

// 2. download via npm, exactly like a consumer would
run('npm', ['pack', `hachiware-pet@${version}`, `--registry=${registry}`, `--cache=${path.join(work, 'npm-cache')}`, `--pack-destination=${work}`]);
const tarball = path.join(work, `hachiware-pet-${version}.tgz`);
check('tarball downloads', existsSync(tarball), `${(statSync(tarball).size / 1024).toFixed(1)} kB`);

// 3. checksum against the registry document
const local = sha1(tarball);
check('sha1 matches registry', local === dist.shasum, local === dist.shasum ? local : `${local} != ${dist.shasum}`);

// 4. unpack and inspect
const pkg = path.join(work, 'package');
run('tar', ['-xzf', tarball, '-C', work]);
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(pkg, full));
  }
};
walk(pkg);
check('file count matches registry', files.length === dist.fileCount, `${files.length} files`);

const manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
check('version in manifest', manifest.version === version, manifest.version);
check('dsh.bundle.patch declared', Boolean(manifest.dsh?.bundle?.patch), manifest.dsh?.bundle?.patch || 'missing');
check('renderer half absent (host-only package)', !manifest.dsh?.client && !existsSync(path.join(pkg, 'client.js')));
check('ships no character art', !files.some((f) => f.startsWith('pet/skins/')));
check('licence + english readme', files.includes('LICENSE') && files.includes('README.en.md'));
check('mac binary bundled', existsSync(path.join(pkg, 'helper/bin/HachiwarePet.app/Contents/MacOS/HachiwarePet')));
check('windows binary bundled', existsSync(path.join(pkg, 'helper/bin/win/HachiwarePet.exe')));

for (const file of ['index.js', 'pet/renderer.js']) run(process.execPath, ['--check', path.join(pkg, file)]);
check('javascript parses', true, 'index.js, pet/renderer.js');
for (const file of files.filter((f) => f.endsWith('.json'))) {
  try { JSON.parse(readFileSync(path.join(pkg, file), 'utf8')); } catch { check(`json parses: ${file}`, false); }
}
check('locale json parses', files.filter((f) => f.startsWith('locale/')).every((f) => {
  try { JSON.parse(readFileSync(path.join(pkg, f), 'utf8')); return true; } catch { return false; }
}));

if (process.platform === 'darwin') {
  const info = run('lipo', ['-info', path.join(pkg, 'helper/bin/HachiwarePet.app/Contents/MacOS/HachiwarePet')]);
  check('mac binary is universal', /x86_64/.test(info) && /arm64/.test(info));
}

// 5. host half: import the published index.js with a fake ctx, expect state.json
const home = path.join(work, 'home');
const hostTest = path.join(work, 'host-test.mjs');
writeFileSync(hostTest, `
process.env.HOME = ${JSON.stringify(home)};
const mod = await import(${JSON.stringify(`file://${path.join(pkg, 'index.js')}`)});
if (typeof mod.apply !== 'function') { console.log('NO_APPLY'); process.exit(1); }
mod.apply({
  sessions: { list: () => [{ id: 'verify', header: { title: 'verify', cwd: process.cwd() } }] },
  agents: { get: () => ({ status: 'running' }) },
  on: () => () => {},
  effect: (fn) => { const d = fn(); return () => d && d(); },
  get: () => ({ get: () => ({ title: 'verify' }) }),
});
await new Promise((r) => setTimeout(r, 1500));
const fs = await import('node:fs');
const statePath = ${JSON.stringify(path.join(home, 'Library/Application Support/dsh-hachiware-pet/state.json'))};
if (!fs.existsSync(statePath)) { console.log('NO_STATE'); process.exit(1); }
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
console.log('STATE', state.sessions.length, state.skin ? 'skin' : 'noskin');
process.exit(0);
`);
const hostOut = run(process.execPath, [hostTest]);
check('host half runs and writes state', /^STATE 1/m.test(hostOut), hostOut.trim().split('\n').pop());

// 6. native shell: launch the bundled binary against a fake state, expect it to render
if (process.platform === 'darwin') {
  const app = path.join(pkg, 'helper/bin/HachiwarePet.app/Contents/MacOS/HachiwarePet');
  const runDir = path.join(work, 'run');
  run('mkdir', ['-p', path.join(runDir, 'skins')]);
  writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    sessions: [{ id: 'verify', title: 'verify', running: true, runningMs: 60000, approval: null }],
    approvals: [], active: 1, idle: 0,
    skin: { ready: false, slug: '', name: '', version: '', installing: false, error: '', options: [] },
  }));
  const env = {
    ...process.env,
    DSH_HACHIWARE_PET_STATE: path.join(runDir, 'state.json'),
    DSH_HACHIWARE_PET_POS: path.join(runDir, 'pos.json'),
    DSH_HACHIWARE_PET_LOG: path.join(runDir, 'helper.log'),
    DSH_HACHIWARE_PET_SNAPSHOT: path.join(runDir, 'shot.png'),
    DSH_HACHIWARE_PET_SKINS: path.join(runDir, 'skins'),
    DSH_HACHIWARE_PET_PARENT: String(process.pid),
    DSH_HACHIWARE_PET_PETDIR: path.join(pkg, 'pet'),
  };
  const { spawn } = await import('node:child_process');
  const helper = spawn(app, [], { env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 4000));
  helper.kill('SIGTERM');
  const log = existsSync(path.join(runDir, 'helper.log')) ? readFileSync(path.join(runDir, 'helper.log'), 'utf8') : '';
  check('native shell renders the page', /page finished/.test(log), log.split('\n').filter(Boolean).slice(-1)[0] || 'no log');
  const shot = path.join(runDir, 'shot.png');
  check('native shell produced a snapshot', existsSync(shot) && statSync(shot).size > 5000, existsSync(shot) ? `${(statSync(shot).size / 1024).toFixed(1)} kB` : 'missing');
} else {
  console.log('  skip  native shell smoke test (macOS only)');
}

// 7. summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ''}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  process.exit(1);
}
