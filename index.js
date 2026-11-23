/**
 * 小八的宿主半：把 Harness 的会话状态写成 state.json，并养一个原生小窗。
 *
 * Profile 插件跑在桌面壳的 `ELECTRON_RUN_AS_NODE` 子进程里，拿不到 electron
 * 模块，所以这里不开 BrowserWindow：只写状态文件，再启动 helper/ 里那支 Swift
 * 小应用，由它持有透明置顶的 NSPanel + WKWebView，加载 pet/ 下的宠物页面。
 *
 * 全流程 best-effort：编译或启动失败只写日志，绝不影响 Harness 本身。
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Cordis only hands a plugin the services it declares; without this the pet sees
// an empty session catalog.
export const inject = ['sessions', 'agents'];

const here = path.dirname(fileURLToPath(import.meta.url));
// A linked checkout resolves outside node_modules; only there does a source
// edit justify recompiling the companion binary.
const devCheckout = !here.split(path.sep).includes('node_modules');
const isWindows = process.platform === 'win32';
const dataDir = isWindows
  ? path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'dsh-hachiware-pet')
  : process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'dsh-hachiware-pet')
    : path.join(tmpdir(), 'dsh-hachiware-pet');
const stateFile = path.join(dataDir, 'state.json');
const positionFile = path.join(dataDir, 'position.json');
const logFile = path.join(dataDir, 'helper.log');
const buildLog = path.join(here, 'helper', 'build.log');
/// macOS ships an .app built by helper/build.sh; Windows ships a single .exe
/// produced by helper-win/build.ps1. Both read the same state/command files.
const helperApp = isWindows
  ? path.join(here, 'helper', 'bin', 'win', 'HachiwarePet.exe')
  : path.join(here, 'helper', 'bin', 'HachiwarePet.app');
const helperBinary = isWindows
  ? helperApp
  : path.join(helperApp, 'Contents', 'MacOS', 'HachiwarePet');
const windowsBuild = path.join(here, 'helper-win', 'build.ps1');
const petDir = path.join(here, 'pet');
const helperSource = path.join(here, 'helper', 'main.swift');
const buildScript = path.join(here, 'helper', 'build.sh');
// Skins live outside the package: the market bundle ships none, and an install
// has to survive upgrades of the plugin itself.
const skinsDir = path.join(dataDir, 'skins');
const currentSkinFile = path.join(skinsDir, 'current.json');
const seededFile = path.join(skinsDir, '.seeded');
const commandFile = path.join(dataDir, 'command.json');
const installLog = path.join(dataDir, 'install.log');
/// Seeds a fresh install; every other skin on disk is a local choice.
const DEFAULT_SKIN = 'hachiware-2';
const catalogFile = path.join(dataDir, 'petdex-catalog.json');
const PETDEX_CATALOG = 'https://petdex.dev/api/manifest/v2';
/// petdex drops what it downloads in one of these, keyed by slug.
const petdexDirs = (slug) => [
  path.join(homedir(), '.petdex', 'pets', slug),
  path.join(homedir(), '.codex', 'pets', slug),
];

const log = (message) => {
  try {
    mkdirSync(dataDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    if (existsSync(logFile)) {
      writeFileSync(logFile, readFileSync(logFile, 'utf8') + line);
    } else {
      writeFileSync(logFile, line);
    }
  } catch {
    /* logging is best-effort */
  }
};

const newest = (files) => {
  let newestMs = 0;
  for (const file of files) {
    try {
      newestMs = Math.max(newestMs, statSync(file).mtimeMs);
    } catch {
      /* missing source never counts as stale */
    }
  }
  return newestMs;
};

const newestIn = (dir) => {
  let newestMs = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    newestMs = Math.max(newestMs, entry.isDirectory() ? newestIn(full) : newest([full]));
  }
  return newestMs;
};

// A skin ship changes the page even when the Swift sources did not.
const stampOf = (target) => {
  try {
    const stat = statSync(target);
    return stat.isDirectory() ? newestIn(target) : stat.mtimeMs;
  } catch {
    return 0;
  }
};

export function apply(ctx) {
  // The native shell exists for macOS (Swift/AppKit) and Windows (C#/WebView2);
  // everywhere else the pet simply stays off.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return;
  }

  log(`apply: sessions=${ctx.sessions && typeof ctx.sessions.list} agents=${ctx.agents && typeof ctx.agents.get}`);

  /** sessionId -> { toolName, reason } for requests that have not been answered. */
  const approvals = new Map();
  /** sessionId -> epoch ms when its agent started running. */
  const runningSince = new Map();

  let child = null;
  let launchedAt = 0;
  let missingLogged = false;
  let launchFailed = false;
  let timer = null;
  let disposed = false;
  let lastWritten = '';
  let installing = false;
  let skinError = '';

  const snapshot = () => {
    const sessions = [];
    let list = [];
    try {
      list = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : [];
    } catch {
      list = [];
    }
    for (const session of list) {
      const id = session?.id;
      if (!id) continue;
      let running = false;
      try {
        running = ctx.agents?.get?.(id)?.status === 'running';
      } catch {
        running = false;
      }
      if (running && !runningSince.has(id)) runningSince.set(id, Date.now());
      if (!running) runningSince.delete(id);
      const header = session.header || {};
      let title = '';
      try {
        const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
        const snapshotTitle = titles && typeof titles.get === 'function' ? titles.get(session)?.title : undefined;
        if (typeof snapshotTitle === 'string') title = snapshotTitle;
      } catch {
        title = '';
      }
      if (!title) title = header.title || header.displayTitle || '';
      if (!title && typeof header.cwd === 'string') title = path.basename(header.cwd);
      sessions.push({
        id,
        title,
        running,
        runningMs: running && runningSince.has(id) ? Date.now() - runningSince.get(id) : 0,
        approval: approvals.get(id) || null,
      });
    }
    sessions.sort((left, right) => {
      const rank = (session) => (session.approval ? 0 : session.running ? 1 : 2);
      return rank(left) - rank(right) || Number(right.runningMs) - Number(left.runningMs);
    });
    return {
      sessions,
      approvals: [...approvals.values()].map((value) => ({ id: value.id, ...value })),
      skin: {
        ready: Boolean(readCurrentSkin()),
        slug: currentSkin()?.slug || '',
        name: currentSkin()?.displayName || '',
        version: currentSkin()?.installedAt || '',
        installing,
        error: skinError,
        options: listSkins(),
      },
    };
  };

  const writeState = () => {
    if (disposed) return;
    try {
      const text = JSON.stringify(snapshot());
      if (text === lastWritten) return;
      lastWritten = text;
      const staging = `${stateFile}.tmp`;
      writeFileSync(staging, text);
      renameSync(staging, stateFile);
    } catch (error) {
      log(`state write failed: ${error?.message || error}`);
    }
  };

  const readCurrentSkin = () => {
    try {
      return JSON.parse(readFileSync(currentSkinFile, 'utf8'));
    } catch {
      return null;
    }
  };

  const currentSkin = () => readCurrentSkin();

  /// Every skin folder holding a sprite, ready to switch to with one click.
  const listSkins = () => {
    let names = [];
    try {
      names = readdirSync(skinsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const options = [];
    for (const slug of names) {
      if (!existsSync(path.join(skinsDir, slug, 'spritesheet.webp'))) continue;
      let name = slug;
      try {
        const manifest = JSON.parse(readFileSync(path.join(skinsDir, slug, 'pet.json'), 'utf8'));
        name = manifest.displayName || manifest.name || slug;
      } catch {
        /* the folder name is a fine fallback */
      }
      options.push({ slug, name });
    }
    return options.sort((left, right) => left.name.localeCompare(right.name));
  };

  /// Petdex publishes its whole catalog as one manifest; cache it for a day.
  let catalog = null;
  const loadCatalog = async () => {
    if (catalog) return catalog;
    try {
      const cached = JSON.parse(readFileSync(catalogFile, 'utf8'));
      if (cached && Array.isArray(cached.pets) && Date.now() - cached.at < 86400000) {
        catalog = cached.pets;
        return catalog;
      }
    } catch {
      /* no cache yet */
    }
    const response = await fetch(PETDEX_CATALOG);
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const body = await response.json();
    const rows = Array.isArray(body?.pets) ? body.pets : [];
    catalog = rows
      .filter((row) => Array.isArray(row) && row[0] && row[4])
      .map((row) => ({ slug: row[0], name: row[1] || row[0], sprite: row[4], version: row[7] || 1 }));
    try {
      writeFileSync(catalogFile, JSON.stringify({ at: Date.now(), pets: catalog }));
    } catch {
      /* a cache miss next time is harmless */
    }
    return catalog;
  };

  /// Reads the pixel size out of a WebP header: petdex sheets are 1536×1872
  /// (8×9) or 1536×2288 (8×11), and the row count decides which frame band is
  /// visible, so it has to come from the file rather than a guess.
  const webpSize = (buffer) => {
    try {
      if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
      let offset = 12;
      while (offset + 8 <= buffer.length) {
        const type = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (type === 'VP8X') {
          return {
            width: 1 + (buffer[body + 4] | (buffer[body + 5] << 8) | (buffer[body + 6] << 16)),
            height: 1 + (buffer[body + 7] | (buffer[body + 8] << 8) | (buffer[body + 9] << 16)),
          };
        }
        if (type === 'VP8 ') {
          if (buffer[body + 3] !== 0x9d || buffer[body + 4] !== 0x01 || buffer[body + 5] !== 0x2a) return null;
          return {
            width: buffer.readUInt16LE(body + 6) & 0x3fff,
            height: buffer.readUInt16LE(body + 8) & 0x3fff,
          };
        }
        if (type === 'VP8L') {
          if (buffer[body] !== 0x2f) return null;
          const bits = buffer.readUInt32LE(body + 1);
          return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        offset = body + size + (size % 2);
      }
      return null;
    } catch {
      return null;
    }
  };

  /// Frames are 192×208 by convention; derive the grid from the real pixels so
  /// 8×11 sheets keep all eleven rows instead of being squashed to nine.
  const gridOf = (width, height) => {
    if (width % 192 === 0 && height % 208 === 0) {
      return { columns: width / 192, rows: height / 208, cell: { width: 192, height: 208 } };
    }
    const columns = 8;
    const cellWidth = width / columns;
    const rows = Math.max(1, Math.round(height / (cellWidth * (208 / 192))));
    return { columns, rows, cell: { width: cellWidth, height: height / rows } };
  };

  /// Writes the runtime skin manifest the helper reads. Frames are measured by
  /// the helper itself (petdex sheets leave unused cells empty), so only the
  /// grid geometry and mood rows live here.
  const writeCurrentSkin = (slug) => {
    const dir = path.join(skinsDir, slug);
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'pet.json'), 'utf8'));
    } catch {
      manifest = {};
    }
    let override = {};
    try {
      override = JSON.parse(readFileSync(path.join(dir, 'skin.json'), 'utf8'));
    } catch {
      override = {};
    }
    let grid = { columns: 8, rows: 9, cell: { width: 192, height: 208 } };
    try {
      const size = webpSize(readFileSync(path.join(dir, 'spritesheet.webp')));
      if (size && size.width > 0 && size.height > 0) grid = gridOf(size.width, size.height);
    } catch {
      /* keep the 8×9 default */
    }
    const config = {
      slug,
      displayName: override.displayName || manifest.displayName || slug,
      spritesheet: 'spritesheet.webp',
      columns: Number(override.columns) || grid.columns,
      rows: Number(override.rows) || grid.rows,
      fps: Number(override.fps) || 8,
      cell: override.cell || grid.cell,
      moods: override.moods || { idle: 0, focused: 7, strained: 1, tired: 6, alert: 3 },
      frames: Array.isArray(override.frames) ? override.frames : null,
      installedAt: new Date().toISOString(),
    };
    mkdirSync(skinsDir, { recursive: true });
    const staging = `${currentSkinFile}.tmp`;
    writeFileSync(staging, JSON.stringify(config, null, 2));
    renameSync(staging, currentSkinFile);
  };

  /// Local checkout convenience: a skin bundled in the package seeds the data
  /// dir so development keeps working. Market builds ship no skins.
  const seedSkin = () => {
    // Only a first run seeds: deleting every skin must stay deleted.
    if (existsSync(seededFile) || readCurrentSkin()) return;
    const bundled = path.join(here, 'pet', 'skins', DEFAULT_SKIN);
    if (!existsSync(path.join(bundled, 'spritesheet.webp'))) return;
    try {
      cpSync(bundled, path.join(skinsDir, DEFAULT_SKIN), { recursive: true, force: true });
      writeCurrentSkin(DEFAULT_SKIN);
      writeFileSync(seededFile, '');
      log('skin seeded from package');
    } catch (error) {
      log(`skin seed failed: ${error?.message || error}`);
    }
  };

  const SKIN_ATTEMPTS = 3;

  /// One petdex run. The network is flaky, so the caller retries a few times.
  const attemptPetdex = (slug, onDone) => {
    let out = null;
    try {
      mkdirSync(dataDir, { recursive: true });
      out = openSync(installLog, 'a');
    } catch {
      out = null;
    }
    const closeOut = () => {
      if (out !== null) {
        try {
          closeSync(out);
        } catch {
          /* already closed */
        }
        out = null;
      }
    };
    let child;
    try {
      const shell = isWindows
        ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `npx --yes petdex@latest install ${slug}`] }
        : { command: '/bin/zsh', args: ['-lc', `npx --yes petdex@latest install ${slug}`] };
      child = spawn(shell.command, shell.args, {
        env: { ...process.env, npm_config_cache: path.join(dataDir, 'npm-cache') },
        stdio: out === null ? 'ignore' : ['ignore', out, out],
      });
    } catch (error) {
      closeOut();
      onDone(`spawn failed: ${error?.message || error}`);
      return;
    }
    let settled = false;
    let deadline = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      closeOut();
      onDone(error);
    };
    deadline = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      settle('timed out after 3 minutes');
    }, 180000);
    child.on('error', (error) => settle(`spawn failed: ${error?.message || error}`));
    child.on('exit', (code) => {
      if (code !== 0) {
        settle(`petdex exited with ${code}`);
        return;
      }
      const source = petdexDirs(slug).find((dir) => existsSync(path.join(dir, 'spritesheet.webp')));
      if (!source) {
        settle('petdex exited 0 but wrote no pet');
        return;
      }
      try {
        cpSync(source, path.join(skinsDir, slug), { recursive: true, force: true });
        writeCurrentSkin(slug);
        settle('');
      } catch (error) {
        settle(`copy failed: ${error?.message || error}`);
      }
    });
  };

  const installSkin = (slug = DEFAULT_SKIN) => {
    if (installing) return;
    installing = true;
    skinError = '';
    writeState();

    const tryOnce = (attempt) => {
      log(`skin install: ${slug} (attempt ${attempt}/${SKIN_ATTEMPTS})`);
      attemptPetdex(slug, (error) => {
        if (error && attempt < SKIN_ATTEMPTS && !disposed) {
          log(`skin install: ${error} - retrying`);
          setTimeout(() => {
            if (!disposed) tryOnce(attempt + 1);
          }, 2500 * attempt);
          return;
        }
        installing = false;
        skinError = error || '';
        writeState();
        log(`skin install: ${error || 'ready'}`);
      });
    };
    tryOnce(1);
  };

  /// Switches to a skin already on disk. The helper re-reads current.json and
  /// re-injects the sprite, so this is instant and offline.
  const switchSkin = (slug) => {
    if (!slug || !existsSync(path.join(skinsDir, slug, 'spritesheet.webp'))) {
      log(`skin switch: no such skin "${slug}"`);
      return;
    }
    writeCurrentSkin(slug);
    log(`skin switch: ${slug}`);
    writeState();
  };

  /// Removes an installed skin. If it was the current one the pet falls back
  /// to another installed skin, or to the hand-drawn SVG when none are left.
  const deleteSkin = (slug) => {
    const clean = String(slug || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clean)) {
      log(`skin delete: bad slug "${clean}"`);
      return;
    }
    const dir = path.join(skinsDir, clean);
    if (path.dirname(dir) !== skinsDir || !existsSync(dir)) {
      log(`skin delete: no such skin "${clean}"`);
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`skin delete failed: ${error?.message || error}`);
      return;
    }
    log(`skin delete: ${clean}`);
    if ((currentSkin()?.slug || '') === clean) {
      const rest = listSkins().filter((skin) => skin.slug !== clean);
      if (rest.length) {
        writeCurrentSkin(rest[0].slug);
      } else {
        try {
          unlinkSync(currentSkinFile);
        } catch {
          /* already gone */
        }
      }
    }
    writeState();
  };

  /// "New skin" picks a pet from the petdex catalog that is not installed yet.
  const installRandomSkin = async () => {
    if (installing) return;
    let pets = [];
    try {
      pets = await loadCatalog();
    } catch (error) {
      log(`skin catalog failed: ${error?.message || error}`);
      installing = false;
      skinError = `皮肤库取不到：${error?.message || error}`;
      writeState();
      return;
    }
    const have = new Set(listSkins().map((option) => option.slug));
    const pool = pets.filter((pet) => !have.has(pet.slug));
    if (pool.length === 0) {
      skinError = '皮肤库已经全装完了';
      writeState();
      return;
    }
    // Prefer the v2 atlas format, which is what the renderer understands best.
    const v2 = pool.filter((pet) => Number(pet.version) >= 2);
    const pick = (v2.length > 0 ? v2 : pool)[Math.floor(Math.random() * (v2.length > 0 ? v2.length : pool.length))];
    log(`skin pick: ${pick.slug} (${pick.name})`);
    skinError = '';
    installSkin(pick.slug);
  };

  /// The page cannot run a downloader; it drops a request file and this polls it.
  const pollCommand = () => {
    let command;
    try {
      command = JSON.parse(readFileSync(commandFile, 'utf8'));
    } catch {
      return;
    }
    if (!command || typeof command.action !== 'string') return;
    log(`command: ${command.action}${command.slug ? ` ${command.slug}` : ''}`);
    try {
      unlinkSync(commandFile);
    } catch {
      /* the page may clear it first */
    }
    if (command.action === 'switch-skin') {
      switchSkin(command.slug);
      return;
    }
    if (command.action === 'delete-skin') {
      deleteSkin(command.slug);
      return;
    }
    if (command.action === 'new-skin') {
      installRandomSkin();
      return;
    }
    if (command.action === 'install-skin') installSkin(command.slug || DEFAULT_SKIN);
  };

  const buildAndLaunch = (done) => {
    if (isWindows) {
      if (existsSync(helperBinary)) {
        done();
        return;
      }
      log('building windows helper');
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsBuild], { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) log(`windows build failed: ${String(error.message || error)}\n${String(stderr || '').slice(-1200)}`);
        else log(`windows build ok: ${String(stdout || '').trim().split('\n').pop()}`);
        done();
      });
      return;
    }
    if (existsSync(helperBinary) && !devCheckout && process.env.DSH_HACHIWARE_PET_DEV !== '1') {
      // Installed copy: the published binary is the artifact. Rebuilding it in
      // node_modules would need a Swift toolchain the user may not have.
      done();
      return;
    }
    const sources = [
      helperSource,
      path.join(here, 'pet', 'index.html'),
      path.join(here, 'pet', 'renderer.js'),
      path.join(here, 'pet', 'skins'),
    ];
    let stale = !existsSync(helperBinary);
    if (!stale) {
      try {
        stale = Math.max(...sources.map(stampOf)) > statSync(helperBinary).mtimeMs;
      } catch {
        stale = false;
      }
    }
    if (!stale) {
      done();
      return;
    }
    log('building companion helper');
    execFile('/bin/sh', [buildScript], { timeout: 240000 }, (error) => {
      if (error) {
        let detail = String(error.message || error);
        try {
          detail += `\n${readFileSync(buildLog, 'utf8').slice(-1500)}`;
        } catch {
          /* no build log */
        }
        log(`build failed: ${detail}`);
      } else {
        log('build ok');
      }
      done();
    });
  };

  const launch = () => {
    if (disposed || child) return;
    if (!existsSync(helperBinary)) {
      if (!missingLogged) {
        log('helper binary missing');
        missingLogged = true;
      }
      return;
    }
    missingLogged = false;
    try {
      child = spawn(helperBinary, [], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          DSH_HACHIWARE_PET_STATE: stateFile,
          DSH_HACHIWARE_PET_POS: positionFile,
          DSH_HACHIWARE_PET_LOG: logFile,
          DSH_HACHIWARE_PET_PARENT: String(process.pid),
          // The hub runs in a Node child of the desktop shell; the shell (our
          // grandparent) is the process that owns the Harness window.
          DSH_HACHIWARE_PET_APP_PID: String(process.ppid),
          DSH_HACHIWARE_PET_SKINS: skinsDir,
          DSH_HACHIWARE_PET_COMMAND: commandFile,
          DSH_HACHIWARE_PET_PETDIR: petDir,
        },
      });
      launchedAt = Date.now();
      launchFailed = false;
      child.on('error', (error) => log(`helper spawn failed: ${error.message}`));
      child.on('exit', (code, signal) => {
        log(`helper exited code=${code} signal=${signal}`);
        child = null;
      });
      child.unref();
      log(`helper launched pid=${child.pid}`);
    } catch (error) {
      child = null;
      if (!launchFailed) {
        launchFailed = true;
        log(`helper launch failed: ${error?.message || error}`);
      }
    }
  };

  const ensureRunning = () => {
    if (child || Date.now() - launchedAt < 5000) return;
    launch();
  };

  try {
    ctx.on('agent/status', () => writeState());
    ctx.on('agent/created', () => writeState());
    ctx.on('agent/disposed', () => writeState());
    ctx.on('session/event', (session, event) => {
      const type = event?.type;
      if (type === 'approval/asked') {
        approvals.set(session.id, {
          id: session.id,
          toolName: event.data?.toolName || '',
          reason: event.data?.reason || '',
        });
      } else if (type === 'approval/decided') {
        approvals.delete(session.id);
      } else if (type === 'session/title' || type === 'session/header') {
        writeState();
        return;
      } else {
        return;
      }
      writeState();
    });
  } catch (error) {
    log(`listeners failed: ${error?.message || error}`);
  }

  ctx.effect(() => {
    seedSkin();
    writeState();
    buildAndLaunch(() => {
      launch();
      ensureRunning();
    });
    timer = setInterval(() => {
      writeState();
      ensureRunning();
      pollCommand();
    }, 1200);
    if (typeof timer.unref === 'function') timer.unref();

    return () => {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (child) {
        try {
          if (isWindows) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          else child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        child = null;
      }
    };
  }, 'hachiware-pet: desktop companion');
}
