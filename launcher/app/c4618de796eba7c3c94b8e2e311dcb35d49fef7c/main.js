// TERRAVOLT desktop launcher (Electron)
// - serves the launcher and game files from ./web over app://terravolt/ (offline, own saves)
// - first run from a downloaded folder: installs to %LOCALAPPDATA%\Programs\TERRAVOLT and adds Desktop + Start menu shortcuts
const { app, BrowserWindow, protocol, net, shell, dialog, ipcMain, Menu } = require('electron');
const path = require('path'), fs = require('fs'), url = require('url'), os = require('os');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.setAppUserModelId('com.terravolt.launcher');
if (!app.requestSingleInstanceLock()) { app.quit(); }

const WEB = path.join(__dirname, 'web');
// ---- like .minecraft: everything the launcher downloads lives in %APPDATA%\.terravolt
const GAMEDIR = path.join(app.getPath('appData'), '.terravolt');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { return {}; } })();
const CDN = (() => { try { const o = JSON.parse(fs.readFileSync(path.join(GAMEDIR, 'launcher_settings.json'), 'utf8')); if (o.cdn) return o.cdn; } catch (e) {} return CFG.cdn || ''; })();
const BUNDLED_UI = (() => { try { return fs.readFileSync(path.join(WEB, 'launcher_version.txt'), 'utf8').trim(); } catch (e) { return '0'; } })();
const APPDIR = path.dirname(process.execPath);
const EXE = path.basename(process.execPath);
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', 'TERRAVOLT');
let win = null;

function shortcuts(dir) {
  if (process.platform !== 'win32') return;
  const target = path.join(dir, EXE), icon = path.join(dir, 'resources', 'app', 'icon.ico');
  const opts = { target, cwd: dir, icon, iconIndex: 0, description: 'TERRAVOLT Launcher', appUserModelId: 'com.terravolt.launcher' };
  const places = [path.join(app.getPath('desktop'), 'TERRAVOLT.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TERRAVOLT.lnk')];
  for (const p of places) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); shell.writeShortcutLink(p, fs.existsSync(p) ? 'replace' : 'create', opts); } catch (e) {} }
}

async function maybeInstall() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  const here = path.resolve(APPDIR).toLowerCase(), there = path.resolve(INSTALL_DIR).toLowerCase();
  if (here === there) { shortcuts(INSTALL_DIR); return false; }      // already installed: keep the shortcuts fresh
  const r = await dialog.showMessageBox({ type: 'question', title: 'TERRAVOLT', icon: path.join(__dirname, 'icon.ico'),
    message: 'تثبيت TERRAVOLT على جهازك؟', detail: 'ينحط اللانشر في جهازك وتطلع له أيقونة على سطح المكتب وفي قائمة ابدأ.',
    buttons: ['تثبيت', 'تشغيل بدون تثبيت'], defaultId: 0, cancelId: 1 });
  if (r.response !== 0) return false;
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.cpSync(APPDIR, INSTALL_DIR, { recursive: true, force: true });
    shortcuts(INSTALL_DIR);
    require('child_process').spawn(path.join(INSTALL_DIR, EXE), [], { detached: true, stdio: 'ignore', cwd: INSTALL_DIR }).unref();
    return true;
  } catch (e) {
    dialog.showErrorBox('TERRAVOLT', 'ما قدرت أثبّت اللعبة: ' + e.message);
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 780, minWidth: 900, minHeight: 600, show: false,
    title: 'TERRAVOLT Launcher', backgroundColor: '#0d1114', icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadURL('app://terravolt/index.html');
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type === 'keyDown' && i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (i.type === 'keyDown' && i.control && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); }
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
ipcMain.on('tv-quit', e => { const w = BrowserWindow.fromWebContents(e.sender); if (w && w === gameWin) gameWin.close(); else app.quit(); });
const NETM = require('./net'); const NETC = NETM.setupIPC(ipcMain, () => win);
app.on('before-quit', () => { try { NETC.shutdown(); } catch (e) {} });
ipcMain.on('tv-fullscreen', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!!on); });

// ================= updates, the Mojang way =================
// CDN layout (static files, e.g. GitHub Pages):
//   mc/game/version_manifest_v2.json      {latest:{release,snapshot}, versions:[{id,type,url,time,releaseTime,sha1,...}]}
//   v1/packages/<sha1>/<id>.json          one version: its files and its asset index, each with sha1 + size + url
//   v1/objects/<sha1>/<name>              game files (immutable)
//   resources/<xx>/<hash>                 shared assets (three.js, music, map), stored by hash
//   launcher/launcher.json                the launcher itself: version + files
const vcmp = (a, b) => { const A = String(a).split(/[.\-]/).map(x => parseInt(x) || 0), B = String(b).split(/[.\-]/).map(x => parseInt(x) || 0); for (let i = 0; i < Math.max(A.length, B.length); i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0); } return 0; };
const sha1 = buf => require('crypto').createHash('sha1').update(buf).digest('hex');
const abs = rel => new URL(rel, CDN.endsWith('/') ? CDN : CDN + '/').toString();
const mk = p => fs.mkdirSync(p, { recursive: true });
const readJSON = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
async function getBuf(u) { const r = await net.fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' → HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); }
async function getJSON(u, want) { const b = await getBuf(u); if (want && sha1(b) !== want) throw new Error('sha1 mismatch ' + u); return JSON.parse(b.toString('utf8')); }
// download one file, check its hash, write it atomically
async function fetchTo(u, dest, want, onBytes) {
  const r = await net.fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' → HTTP ' + r.status);
  const rd = r.body.getReader(), parts = []; let n = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; onBytes && onBytes(value.length); }
  const buf = Buffer.concat(parts, n); if (want && sha1(buf) !== want) throw new Error('الملف وصل ناقص أو خربان: ' + path.basename(dest));
  mk(path.dirname(dest)); fs.writeFileSync(dest + '.part', buf); fs.renameSync(dest + '.part', dest); }
const okFile = (p, size) => { try { return fs.statSync(p).size === size; } catch (e) { return false; } };
const MAN_CACHE = path.join(GAMEDIR, 'versions', 'version_manifest_v2.json');
async function manifest(fresh) {
  let m = null;
  if (CDN) { try { m = await getJSON(abs('mc/game/version_manifest_v2.json')); mk(path.dirname(MAN_CACHE)); fs.writeFileSync(MAN_CACHE, JSON.stringify(m)); } catch (e) { console.warn('manifest', e.message); } }
  if (!m) m = readJSON(MAN_CACHE) || { latest: {}, versions: [] };
  // versions you have installed stay playable offline even if the server no longer lists them
  for (const id of installed()) if (!m.versions.some(v => v.id === id)) { const vj = readJSON(path.join(GAMEDIR, 'versions', id, id + '.json')) || {}; m.versions.push({ id, type: vj.type || 'release', releaseTime: vj.releaseTime, title: vj.title || '', notes: vj.notes || [], size: vj.size || 0, offline: true }); }
  return m; }
function installed() { const d = path.join(GAMEDIR, 'versions'); let out = []; try { out = fs.readdirSync(d).filter(id => { const vj = readJSON(path.join(d, id, id + '.json')); return vj && (vj.files || []).every(f => okFile(path.join(d, id, f.path), f.size)); }); } catch (e) {} return out; }
const ASSETMAP = new Map();
function loadAssetIndex(idx) { const j = readJSON(path.join(GAMEDIR, 'assets', 'indexes', idx + '.json')); if (j) for (const [name, o] of Object.entries(j.objects || {})) ASSETMAP.set(name, o.hash); }
function loadAllIndexes() { try { for (const f of fs.readdirSync(path.join(GAMEDIR, 'assets', 'indexes'))) loadAssetIndex(f.replace(/\.json$/, '')); } catch (e) {} }
async function install(id, force, prog) {
  const m = await manifest(true), e = m.versions.find(v => v.id === id); const vdir = path.join(GAMEDIR, 'versions', id);
  let vj; if (e && e.url && CDN) { vj = await getJSON(abs(e.url), e.sha1); mk(vdir); fs.writeFileSync(path.join(vdir, id + '.json'), JSON.stringify(vj, null, 1)); }
  else vj = readJSON(path.join(vdir, id + '.json')); if (!vj) throw new Error('ما لقيت الإصدار ' + id);
  const jobs = [];
  for (const f of vj.files) { const dest = path.join(vdir, f.path); if (force || !okFile(dest, f.size)) jobs.push([abs(f.url), dest, f.sha1, f.size]); }
  if (vj.assetIndex) { const ai = vj.assetIndex, ip = path.join(GAMEDIR, 'assets', 'indexes', ai.id + '.json'); let idx = readJSON(ip);
    if (!idx || force) { idx = await getJSON(abs(ai.url), ai.sha1); mk(path.dirname(ip)); fs.writeFileSync(ip, JSON.stringify(idx)); }
    for (const [name, o] of Object.entries(idx.objects)) { const dest = path.join(GAMEDIR, 'assets', 'objects', o.hash.slice(0, 2), o.hash); if (force || !okFile(dest, o.size)) jobs.push([abs('resources/' + o.hash.slice(0, 2) + '/' + o.hash), dest, o.hash, o.size]); }
    loadAssetIndex(ai.id); }
  const total = jobs.reduce((a, j) => a + j[3], 0) || 1; let got = 0;
  prog({ got: 0, total, files: jobs.length });
  for (const [u, dest, h, size] of jobs) { await fetchTo(u, dest, h, b => { got += b; prog({ got, total, file: path.basename(dest) }); }); }
  prog({ got: total, total, done: true }); return true; }
// the launcher updates itself: new launcher files go to .terravolt/launcher and are used from the next start
function uiDir() { const d = path.join(GAMEDIR, 'launcher'), v = readJSON(path.join(d, 'launcher.json')); if (v && vcmp(v.version, BUNDLED_UI) > 0 && (v.files || []).every(f => okFile(path.join(d, f.path), f.size))) return d; return WEB; }
async function selfUpdate() { if (!CDN) return false; try {
    const L = await getJSON(abs('launcher/launcher.json')), d = path.join(GAMEDIR, 'launcher'), cur = readJSON(path.join(d, 'launcher.json'));
    const have = cur && (cur.files || []).every(f => okFile(path.join(d, f.path), f.size)) ? cur.version : BUNDLED_UI;
    if (vcmp(L.version, have) <= 0 || vcmp(L.version, BUNDLED_UI) <= 0) return false;
    const tmp = d + '_new'; fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of L.files) await fetchTo(abs(f.url), path.join(tmp, f.path), f.sha1);
    fs.writeFileSync(path.join(tmp, 'launcher.json'), JSON.stringify(L)); fs.rmSync(d, { recursive: true, force: true }); fs.renameSync(tmp, d); return true;
  } catch (e) { console.warn('selfUpdate', e.message); return false; } }
// the program itself (main.js, icon…): newer files are written into the installed app, then it restarts once
async function appUpdate() { if (!CDN || !app.isPackaged) return false; try {
    const L = await getJSON(abs('launcher/launcher.json')); const A = L.app; if (!A || vcmp(A.version, app.getVersion()) <= 0) return false;
    const bufs = []; for (const f of A.files) { const b = await getBuf(abs(f.url)); if (sha1(b) !== f.sha1) throw new Error('sha1 ' + f.path); bufs.push([f.path, b]); }
    for (const [p, b] of bufs) { const dest = path.join(__dirname, p); if (!dest.startsWith(__dirname)) continue; fs.writeFileSync(dest + '.new', b); fs.renameSync(dest + '.new', dest); }
    try { const pj = path.join(__dirname, 'package.json'), j = JSON.parse(fs.readFileSync(pj, 'utf8')); j.version = A.version; fs.writeFileSync(pj, JSON.stringify(j, null, 2)); } catch (e) {}
    return true; } catch (e) { console.warn('appUpdate', e.message); return false; } }
// ================= the game runs in its own window, like a real launcher starts the game =================
let gameWin = null, gameOpts = null;
const LSET = () => readJSON(path.join(GAMEDIR, 'launcher_settings.json')) || {};

// ---- editions & licenses (Lemon Squeezy license keys). No key = Demo. ----
const LS_API = (CFG.lsApi || 'https://api.lemonsqueezy.com/v1/licenses/').replace(/\/?$/, '/');
const LICF = () => path.join(GAMEDIR, 'license.json');
const ED_NAMES = { demo: 'TERRAVOLT Demo', std: 'TERRAVOLT', gold: 'TERRAVOLT Gold' };
let SHOP = null;
async function shop() { if (SHOP) return SHOP; try { SHOP = await getJSON(abs('shop.json') + '?t=' + Date.now()); writeJSON(path.join(GAMEDIR, 'shop_cache.json'), SHOP); } catch (e) { SHOP = readJSON(path.join(GAMEDIR, 'shop_cache.json')) || {}; } return SHOP; }
function writeJSON(p, o) { try { fs.writeFileSync(p, JSON.stringify(o, null, 1)); } catch (e) {} }
async function lsCall(op, fields) {
  const body = new URLSearchParams(fields).toString();
  const r = await fetch(LS_API + op, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
function edOf(meta, S) {
  const E = (S && S.editions) || {};
  for (const k of ['gold', 'std']) { const e = E[k] || {}; if ((e.variantId && +e.variantId === +meta.variant_id) || (e.productId && +e.productId === +meta.product_id)) return k; }
  const n = ((meta.product_name || '') + ' ' + (meta.variant_name || '')).toLowerCase();
  if (/gold/.test(n)) return 'gold'; if (/demo/.test(n)) return 'demo'; return 'std';
}
function licPublic(L) { const ed = L && L.ed || 'demo'; return { ed, name: ED_NAMES[ed], key: L && L.key ? (L.local ? 'كود دعوة' : L.key.slice(0, 4) + '••••' + L.key.slice(-4)) : '', email: L && L.email || '', checked: L && L.checked || 0 }; }
function licGet() { return readJSON(LICF()); }
async function licActivate(key) {
  key = String(key || '').trim(); if (!/^[A-Za-z0-9-]{4,80}$/.test(key)) return { ok: false, err: 'الكود غير صحيح' };
  const S = await shop(); let r;
  const ch = require('crypto').createHash('sha256').update(key.toUpperCase()).digest('hex'), cd = S && S.codes && S.codes[ch];
  if (cd && cd.off >= 100 && (cd.ed || []).length) { const ed = cd.ed.includes('gold') ? 'gold' : cd.ed[0]; const L = { key: key.toUpperCase(), code: ch, local: true, ed, checked: Date.now() }; writeJSON(LICF(), L); return { ok: true, lic: licPublic(L) }; }
  try { r = await lsCall('activate', { license_key: key, instance_name: (os.hostname() || 'PC') + ' · TERRAVOLT' }); } catch (e) { return { ok: false, err: 'ما قدرت أتصل بسيرفر التفعيل، تأكد من الإنترنت' }; }
  const j = r.j || {};
  if (!j.activated) { const m = String(j.error || ''); return { ok: false, err: /limit/i.test(m) ? 'هذا الكود مفعّل على أجهزة أكثر من المسموح' : /disabled|expired/i.test(m) ? 'هذا الكود موقوف أو منتهي' : 'الكود غير صحيح' }; }
  const meta = j.meta || {};
  if (S && S.storeId && +meta.store_id !== +S.storeId) { try { await lsCall('deactivate', { license_key: key, instance_id: j.instance && j.instance.id }); } catch (e) {} return { ok: false, err: 'هذا الكود مو للعبة TERRAVOLT' }; }
  const L = { key, instance: j.instance && j.instance.id, ed: edOf(meta, S), email: meta.customer_email || '', checked: Date.now() };
  writeJSON(LICF(), L); return { ok: true, lic: licPublic(L) };
}
async function licValidate() {
  const L = licGet(); if (!L || !L.key) return licPublic(null);
  if (L.local) { SHOP = null; const S = await shop(); if (S && S.codes && !S.codes[L.code]) { fs.rmSync(LICF(), { force: true }); return Object.assign(licPublic(null), { revoked: true }); } return licPublic(L); }
  try {
    const r = await lsCall('validate', { license_key: L.key, instance_id: L.instance || '' }); const j = r.j || {};
    if (r.status >= 500) return licPublic(L);
    const st = j.license_key && j.license_key.status;
    if (!j.valid || st === 'disabled' || st === 'expired') { if (r.status === 404 || r.status === 400 || st) { fs.rmSync(LICF(), { force: true }); return Object.assign(licPublic(null), { revoked: true }); } return licPublic(L); }
    L.ed = edOf(j.meta || {}, await shop()); L.checked = Date.now(); writeJSON(LICF(), L);
  } catch (e) { /* offline: keep the saved edition */ }
  return licPublic(L);
}
async function licRemove() { const L = licGet(); if (L && L.key && !L.local) { try { await lsCall('deactivate', { license_key: L.key, instance_id: L.instance || '' }); } catch (e) {} } fs.rmSync(LICF(), { force: true }); return licPublic(null); }
ipcMain.handle('lic-get', () => licPublic(licGet()));
ipcMain.handle('lic-validate', () => licValidate());
ipcMain.handle('lic-activate', (e, key) => licActivate(key));
ipcMain.handle('lic-remove', () => licRemove());
ipcMain.handle('game-launch', (e, id, o) => {
  if (gameWin) { gameWin.focus(); return { ok: true, already: true }; }
  if (!installed().includes(id)) return { ok: false, err: 'الإصدار مو مثبت' };
  gameOpts = Object.assign({ after: 'hide', fullscreen: false, width: 1600, height: 900, nick: 'Player' }, o || {});
  gameWin = new BrowserWindow({ width: gameOpts.width, height: gameOpts.height, minWidth: 800, minHeight: 500, show: false, title: ED_NAMES[(licGet() || {}).ed || 'demo'] + ' ' + id, backgroundColor: '#000000', icon: path.join(__dirname, 'icon.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  gameWin.removeMenu();
  gameWin.webContents.on('will-prevent-unload', ev => ev.preventDefault());   // the game saves itself; never block closing
  gameWin.loadURL(`app://terravolt/game/${encodeURIComponent(id)}/game.html?nick=${encodeURIComponent(gameOpts.nick)}&ed=${(licGet() || {}).ed || 'demo'}`);
  gameWin.once('ready-to-show', () => { if (gameOpts.fullscreen) gameWin.setFullScreen(true); else if (gameOpts.maximize !== false) gameWin.maximize(); gameWin.show(); gameWin.focus();
    if (win) { if (gameOpts.after === 'close') { win.destroy(); win = null; } else if (gameOpts.after === 'hide') win.hide(); } });
  gameWin.webContents.on('before-input-event', (ev, i) => { if (i.type === 'keyDown' && i.key === 'F11') { gameWin.setFullScreen(!gameWin.isFullScreen()); ev.preventDefault(); } if (i.type === 'keyDown' && i.control && i.shift && i.key.toLowerCase() === 'i') gameWin.webContents.toggleDevTools(); });
  const t0 = Date.now();
  gameWin.webContents.on('render-process-gone', (ev, d) => { gameWin && gameWin.destroy(); onGameClosed({ crash: true, reason: d.reason, secs: (Date.now() - t0) / 1000 }); });
  gameWin.webContents.on('console-message', (ev, level, msg) => { if (level >= 3 && win && !win.isDestroyed()) win.webContents.send('game-log', msg.slice(0, 400)); });
  gameWin.on('closed', () => { if (gameWin) onGameClosed({ secs: (Date.now() - t0) / 1000 }); });
  return { ok: true }; });
function onGameClosed(info) { gameWin = null; if (!win || win.isDestroyed()) { createWindow(); setTimeout(() => win && win.webContents.send('game-closed', info), 1500); return; } win.show(); win.focus(); win.webContents.send('game-closed', info); }
ipcMain.on('game-exit', () => { if (gameWin) gameWin.destroy(); });
ipcMain.on('game-fullscreen', (e, on) => { if (gameWin) gameWin.setFullScreen(!!on); });
ipcMain.handle('game-running', () => !!gameWin);
ipcMain.handle('cdn-delete', (e, id) => { if (!/^[\w.\-]+$/.test(id)) return false; fs.rmSync(path.join(GAMEDIR, 'versions', id), { recursive: true, force: true }); return true; });
ipcMain.handle('cdn-sizes', () => { const d = path.join(GAMEDIR, 'versions'), out = {}; for (const id of installed()) { let n = 0; try { for (const f of fs.readdirSync(path.join(d, id))) n += fs.statSync(path.join(d, id, f)).size; } catch (e) {} out[id] = n; } return out; });
// old version numbers (0.01.6) become the new form (00.01.06): folders and their json are renamed once
function migrateIds() { const d = path.join(GAMEDIR, 'versions'); let list = []; try { list = fs.readdirSync(d); } catch (e) { return; }
  for (const id of list) { const p = id.split('.').map(x => parseInt(x)); if (p.length !== 3 || p.some(isNaN)) continue; const nid = '00.00.' + String(p[1] * 10 + p[2]).padStart(2, '0'); if (nid === id) continue;
    try { const src = path.join(d, id), dst = path.join(d, nid); if (fs.existsSync(dst)) { fs.rmSync(src, { recursive: true, force: true }); continue; } fs.renameSync(src, dst);
      const oj = path.join(dst, id + '.json'); if (fs.existsSync(oj)) { const j = readJSON(oj) || {}; j.id = nid; fs.writeFileSync(path.join(dst, nid + '.json'), JSON.stringify(j, null, 1)); fs.rmSync(oj, { force: true }); } } catch (e) { console.warn('migrate', id, e.message); } } }
ipcMain.handle('cdn-manifest', (e, fresh) => manifest(fresh));
ipcMain.handle('cdn-installed', () => installed());
ipcMain.handle('cdn-install', (e, id, force) => install(id, !!force, p => { try { e.sender.send('cdn-prog', id, p); } catch (er) {} }));
ipcMain.handle('cdn-info', () => ({ cdn: CDN, gameDir: GAMEDIR, ui: uiDir() === WEB ? BUNDLED_UI : (readJSON(path.join(GAMEDIR, 'launcher', 'launcher.json')) || {}).version, app: app.getVersion() }));
ipcMain.handle('cdn-folder', () => { mk(GAMEDIR); shell.openPath(GAMEDIR); });

app.whenReady().then(async () => {
  if (await maybeInstall()) { app.quit(); return; }
  mk(GAMEDIR); migrateIds(); loadAllIndexes();
  if (await Promise.race([appUpdate(), new Promise(r => setTimeout(() => r(false), 5000))])) { app.relaunch(); app.exit(0); return; }
  // check for a newer launcher (max 4 s), then show the window
  const upd = await Promise.race([selfUpdate(), new Promise(r => setTimeout(() => r(false), 4000))]);
  const send = (file) => { const f = path.normalize(file); return net.fetch(url.pathToFileURL(f).toString()); };
  protocol.handle('app', req => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    // the game: app://terravolt/game/<version>/<file>
    let m = rel.match(/^game\/([^/]+)\/(.+)$/);
    if (m) { const base = path.join(GAMEDIR, 'versions', m[1]), f = path.normalize(path.join(base, m[2])); if (!f.startsWith(base)) return new Response('forbidden', { status: 403 }); return send(f); }
    // shared assets by name -> stored by hash
    m = rel.match(/^assets\/(.+)$/);
    if (m && ASSETMAP.has(m[1])) { const h = ASSETMAP.get(m[1]); return send(path.join(GAMEDIR, 'assets', 'objects', h.slice(0, 2), h)); }
    const root = uiDir(), file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file)) { const fb = path.normalize(path.join(WEB, rel)); if (fb.startsWith(WEB) && fs.existsSync(fb)) return send(fb); }
    return send(file);
  });
  createWindow();
  if (!upd) selfUpdate();   // keep checking in the background; used next start
});
app.on('window-all-closed', () => app.quit());
