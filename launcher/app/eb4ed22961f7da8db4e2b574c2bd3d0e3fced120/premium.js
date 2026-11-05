'use strict';
// Premium Studio integration for the BLOCKFALL launcher:
//  - cloud saves: worlds and progress follow the Premium Studio account to any PC (like Steam Cloud)
//  - achievements: unlocked from the game's own stats and kept on the account
// Everything uses the account the Premium Studio app hands over (servers.js -> token / uid).
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const PROJECT = 'premium-studio-f9bc9';
const FSURL = (process.env.BF_TEST_FS || 'https://firestore.googleapis.com/v1') + `/projects/${PROJECT}/databases/(default)/documents`;
const DOC = p => `projects/${PROJECT}/databases/(default)/documents/${p}`;
const GAME = 'blockfall';
// what the game keeps in its storage that is the player's progress
const SAVE_RE = '^(qitaa-save-v5|qitaa-worlds|qitaa-w-|qitaa-settings|tv-claims-|tv-day-|tv-wp-|bf-story)';
const CHUNK = 700000;
// achievements: [id, test(stats, worlds)] — names and descriptions live in the Premium Studio store (games.json)
const ACH = [
  ['first_block', s => s.plc >= 1], ['builder', s => s.plc >= 1000], ['architect', s => s.plc >= 10000],
  ['miner', s => s.brk >= 500], ['digger', s => s.brk >= 5000],
  ['lumberjack', s => s.tree >= 50], ['shepherd', s => s.sheep >= 10], ['crafter', s => (s.craft || 0) >= 25],
  ['hour', s => s.t >= 3600], ['veteran', s => s.t >= 36000], ['explorer', (s, w) => w >= 3]
];

module.exports = function ({ SRV, GAMEDIR, getWin, getGame, app }) {
  const SYNC = path.join(GAMEDIR, 'premium_cloud.json');
  const rd = () => { try { return JSON.parse(fs.readFileSync(SYNC, 'utf8')); } catch (e) { return {}; } };
  const wr = o => { try { fs.writeFileSync(SYNC, JSON.stringify(o)); } catch (e) {} };
  const uid = () => { try { return SRV.uid(); } catch (e) { return ''; } };

  async function api(method, p, body) {
    const t = await SRV.token();
    const r = await fetch(p.startsWith('http') ? p : `${FSURL}/${p}`, { method, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 404) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || String(r.status));
    return j;
  }
  // a page on app://terravolt (same storage as the game)
  async function page() {
    for (let i = 0; i < 50; i++) { const w = getWin(); if (w && !w.isDestroyed() && !w.webContents.isLoading()) return w.webContents; await new Promise(r => setTimeout(r, 200)); }
    return null;
  }
  const collect = wc => wc.executeJavaScript(`(()=>{const re=new RegExp(${JSON.stringify(SAVE_RE)}),o={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(re.test(k))o[k]=localStorage.getItem(k);}return JSON.stringify(o)})()`, true);

  /* ---- Workshop (Premium Studio): worlds you can share, and worlds you subscribed to ----
     worlds_export/<id>.json : copies of your worlds (written after you play) so Premium Studio can upload one
     workshop_import/<item>.json : {name, data} from Premium Studio, added to your worlds before the game starts */
  const EXP = path.join(GAMEDIR, 'worlds_export'), IMP = path.join(GAMEDIR, 'workshop_import');
  async function exportWorlds(wc) {
    try {
      const j = await wc.executeJavaScript(`(()=>{let w={list:[]};try{w=JSON.parse(localStorage.getItem('qitaa-worlds'))||w}catch(e){};return JSON.stringify((w.list||[]).map(x=>({meta:x,data:localStorage.getItem('qitaa-w-'+x.id)})).filter(x=>x.data))})()`, true);
      const list = JSON.parse(j); fs.rmSync(EXP, { recursive: true, force: true }); fs.mkdirSync(EXP, { recursive: true });
      for (const x of list) fs.writeFileSync(path.join(EXP, String(x.meta.id).replace(/[^a-z0-9]/gi, '') + '.json'), JSON.stringify(x));
    } catch (e) {}
  }
  async function importWorkshop(wc) {
    let files = []; try { files = fs.readdirSync(IMP).filter(f => f.endsWith('.json')); } catch (e) { return; }
    for (const f of files) {
      try { const it = JSON.parse(fs.readFileSync(path.join(IMP, f), 'utf8'));
        const ok = await wc.executeJavaScript(`((it)=>{let w={list:[],last:null};try{w=JSON.parse(localStorage.getItem('qitaa-worlds'))||w}catch(e){};if(!Array.isArray(w.list))w.list=[];
          if(w.list.length>=10)return false;let d;try{d=JSON.parse(it.data)}catch(e){return false};if(!d||d.v!==5)return false;
          const id='ws'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);localStorage.setItem('qitaa-w-'+id,it.data);
          w.list.push({id,name:('🛠 '+String(it.name||'عالم من الورشة')).slice(0,40),mode:it.mode||'c',seed:d.seed,t:Date.now()});localStorage.setItem('qitaa-worlds',JSON.stringify(w));return true})(${JSON.stringify(it)})`, true);
        if (ok) fs.rmSync(path.join(IMP, f), { force: true });
      } catch (e) {}
    }
  }

  // before the game starts: bring the account's saves to this PC if they're newer (or another account played here)
  async function pull() {
    const id = uid(); if (!id) return;
    const meta = await api('GET', `users/${id}/cloud/${GAME}`);
    const st = rd(), other = st.uid && st.uid !== id;
    const v = meta && meta.fields && meta.fields.v ? +meta.fields.v.integerValue : 0;
    if (!other && (!meta || v <= (st.v || 0))) { if (!st.uid) wr({ ...st, uid: id, v: st.v || 0 }); return; }
    let data = {};
    if (meta && v) {
      const n = +meta.fields.parts.integerValue; let b64 = '';
      for (let i = 0; i < n; i++) { const d = await api('GET', `users/${id}/cloud/${GAME}/parts/${i}`); if (!d || +d.fields.v.integerValue !== v) throw new Error('cloud save incomplete'); b64 += d.fields.d.stringValue; }
      data = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
    } else if (!other) return;
    const wc = await page(); if (!wc) return;
    // keep a copy of what was on this PC before replacing it
    try { const cur = await collect(wc); if (cur && cur.length > 2) { const bd = path.join(GAMEDIR, 'save_backups'); fs.mkdirSync(bd, { recursive: true }); fs.writeFileSync(path.join(bd, `before-cloud-${Date.now()}.json`), cur);
      const old = fs.readdirSync(bd).sort(); for (const f of old.slice(0, Math.max(0, old.length - 5))) fs.rmSync(path.join(bd, f), { force: true }); } } catch (e) {}
    await wc.executeJavaScript(`((d)=>{const re=new RegExp(${JSON.stringify(SAVE_RE)});const ks=[];for(let i=0;i<localStorage.length;i++)ks.push(localStorage.key(i));for(const k of ks)if(re.test(k))localStorage.removeItem(k);for(const [k,v] of Object.entries(d))localStorage.setItem(k,v);return 1})(${JSON.stringify(data)})`, true);
    wr({ ...rd(), uid: id, v, last: '' });
  }

  // after the game closes: send the saves to the account
  async function push() {
    const id = uid(); if (!id) return;
    const wc = await page(); if (!wc) return;
    const json = await collect(wc);
    const st = rd(); if (st.uid === id && st.last === json.length + ':' + hash(json)) return;   // nothing changed
    const b64 = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
    const parts = []; for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));
    const v = Date.now();
    const writes = parts.map((d, i) => ({ update: { name: DOC(`users/${id}/cloud/${GAME}/parts/${i}`), fields: { d: { stringValue: d }, v: { integerValue: String(v) } } } }));
    writes.push({ update: { name: DOC(`users/${id}/cloud/${GAME}`), fields: { data: { stringValue: '' }, size: { integerValue: String(json.length) }, parts: { integerValue: String(parts.length) }, v: { integerValue: String(v) } } },
      updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] });
    await api('POST', `${FSURL}:commit`, { writes });
    wr({ ...rd(), uid: id, v, last: json.length + ':' + hash(json) });
    await achievements(json).catch(() => {});
  }
  function hash(s) { return require('crypto').createHash('sha1').update(s).digest('hex'); }

  // achievements from the game's stats
  async function achievements(json) {
    const id = uid(); if (!id) return;
    let o = {}; try { o = JSON.parse(json); } catch (e) { return; }
    let s = {}; try { s = (JSON.parse(o['qitaa-settings'] || '{}').stats) || {}; } catch (e) {}
    s = Object.assign({ t: 0, brk: 0, plc: 0, tree: 0, sheep: 0, craft: 0 }, s);
    const worlds = Object.keys(o).filter(k => k.startsWith('qitaa-w-')).length;
    const st = rd(), all = st.ach && !Array.isArray(st.ach) ? st.ach : {}, have = new Set(all[id] || []);
    const fresh = ACH.filter(([a, t]) => !have.has(a) && t(s, worlds)).map(([a]) => a);
    if (!fresh.length) return;
    const writes = fresh.map(a => ({ update: { name: DOC(`users/${id}/achievements/${GAME}__${a}`), fields: { game: { stringValue: GAME }, id: { stringValue: a } } },
      currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] }));
    for (const w of writes) { try { await api('POST', `${FSURL}:commit`, { writes: [w] }); } catch (e) { if (!/ALREADY_EXISTS|exists/i.test(e.message)) throw e; } }
    const cur = rd(); wr({ ...cur, ach: { ...(cur.ach && !Array.isArray(cur.ach) ? cur.ach : {}), [id]: [...have, ...fresh] } });
  }
  // while playing: check achievements every few minutes
  let tick = null;
  function startTick(getGame) {
    clearInterval(tick);
    tick = setInterval(async () => { const g = getGame(); if (!g || g.isDestroyed()) { clearInterval(tick); return; }
      try { await achievements(await collect(g.webContents)); } catch (e) {} }, 3 * 60000);
  }
  /* ---- tell the Premium Studio app whether BLOCKFALL is open, and take its "close" button ----
     premium_state.json: {pid, open, game, at} every few seconds while a launcher or game window is showing.
     premium_cmd.json:   {cmd:'close', at} written by the Premium Studio app -> save, close the game and quit. */
  const STATE = path.join(GAMEDIR, 'premium_state.json'), CMD = path.join(GAMEDIR, 'premium_cmd.json'), T0 = Date.now();
  let closing = false;
  function beat() {
    const w = getWin(), g = getGame && getGame();
    const open = !!((g && !g.isDestroyed()) || (w && !w.isDestroyed() && w.isVisible()));
    try { fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, open: open && !closing, game: !!(g && !g.isDestroyed()), at: Date.now() })); } catch (e) {}
    let c = null; try { c = JSON.parse(fs.readFileSync(CMD, 'utf8')); } catch (e) {}
    if (c && c.cmd === 'close' && c.at > T0 - 60000 && !closing) { try { fs.rmSync(CMD, { force: true }); } catch (e) {} closeAll(); }
  }
  async function closeAll() {
    closing = true;
    const g = getGame && getGame();
    if (g && !g.isDestroyed()) {   // the game saves itself as it closes, then the saves go to the account
      await new Promise(r => { const t = setTimeout(r, 8000); g.once('closed', () => { clearTimeout(t); r(); }); g.close(); });
      await Promise.race([new Promise(r => setTimeout(r, 900)).then(push).catch(() => {}), new Promise(r => setTimeout(r, 12000))]);
    }
    try { fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, open: false, game: false, at: Date.now() })); } catch (e) {}
    if (app) { for (const w of require('electron').BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (e) {} } app.exit(0); }
  }
  setInterval(beat, 2000); setTimeout(beat, 300);
  setTimeout(async () => { try { const wc = await page(); if (wc) await exportWorlds(wc); } catch (e) {} }, 6000);   // your worlds, ready for the Workshop
  if (app) app.on('will-quit', () => { try { fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, open: false, game: false, at: Date.now() })); } catch (e) {} });

  return {
    beforeGame: () => Promise.race([pull().catch(e => console.warn('cloud pull', e.message)), new Promise(r => setTimeout(r, 15000))])
      .then(() => page()).then(wc => wc && importWorkshop(wc)).catch(() => {}),
    afterGame: () => new Promise(r => setTimeout(r, 800)).then(async () => { const wc = await page(); if (wc) await exportWorlds(wc); }).catch(() => {}).then(push).catch(e => console.warn('cloud push', e.message)),
    startTick
  };
};
