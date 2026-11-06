// BLOCKFALL 3001 servers (launcher main process).
// A server is a lasting world with an owner, a team (roles) and a fixed join code. It is stored in the Premium Studio
// database (Firestore, collection bfServers) and runs on whoever starts it: free servers on a team member's PC,
// paid servers (later) on Premium Studio's machines. A paid server whose subscription ends simply becomes free again.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const API_KEY = 'AIzaSyBLZ4t7g5S03MFQS8ZF5jKDjKER-Te_Me0';
const PROJECT = 'premium-studio-f9bc9';
const FS = (process.env.BF_TEST_FS || 'https://firestore.googleapis.com/v1') + `/projects/${PROJECT}/databases/(default)/documents`;
const COL = 'bfServers';
const BEAT_MS = 30000, STALE_MS = 95000, PART = 700000;

// ---- roles: what each rank on a server may do
const ROLES = ['owner', 'admin', 'mod', 'member'];
const PERMS = {
  owner:  { start: 1, settings: 1, members: 1, roles: 1, kick: 1, ban: 1, world: 1, del: 1, plan: 1, transfer: 1 },
  admin:  { start: 1, settings: 1, members: 1, roles: 1, kick: 1, ban: 1, world: 1 },
  mod:    { start: 1, kick: 1, ban: 1 },
  member: {}
};
const can = (role, p) => !!(PERMS[role] || {})[p];

module.exports = function setup(ipcMain, ctx) {
  const { GAMEDIR } = ctx;
  const ACC_FILE = path.join(GAMEDIR, 'premium_account.json');     // written by the Premium Studio app
  const AUTH_FILE = path.join(GAMEDIR, 'launcher_auth.json');      // our own sign-in, when the file above has no token
  const rd = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const wr = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); } catch (e) {} };

  // ================= account =================
  let A = null;   // {uid, username, name, pid, email, idToken, exp, refresh}
  function account() {
    const p = rd(ACC_FILE) || {}, own = {};   // the account always comes from the Premium Studio app
    const username = String(p.username || own.username || '').slice(0, 20), name = String(p.name || own.name || p.username || '').slice(0, 32);
    const refresh = p.refreshToken || p.refresh_token || own.refresh || '';
    const uid = p.uid || p.localId || own.uid || '';
    if (!A || A.refresh !== refresh || A.username !== username) A = { uid, username, name, pid: String(p.pid || own.pid || ''), email: String(p.email || own.email || ''), refresh, idToken: p.idToken || '', exp: p.idToken && p.exp ? +p.exp : 0 };
    return A;
  }
  const pub = () => { const a = account(); return { username: a.username, name: a.name, pid: a.pid, email: a.email, signedIn: !!(a.username), online: !!a.refresh, fromStudio: !!(rd(ACC_FILE) || {}).username }; };

  async function post(url, body, form) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(errText((j.error && (j.error.message || j.error)) || r.status)); return j;
  }
  function errText(m) { m = String(m);
    if (/INVALID_PASSWORD|INVALID_LOGIN|EMAIL_NOT_FOUND|INVALID_EMAIL/.test(m)) return 'الإيميل أو كلمة السر غلط';
    if (/INVALID_ID_TOKEN/.test(m)) return 'تسجيل الدخول منتهي أو غير صالح';
    if (/TOKEN_EXPIRED|INVALID_REFRESH|USER_NOT_FOUND|USER_DISABLED/.test(m)) return 'انتهت جلسة الحساب، سجّل دخولك مرة ثانية';
    if (/PERMISSION_DENIED|403/.test(m)) return 'ما عندك صلاحية لهذا';
    if (/NOT_FOUND|404/.test(m)) return 'السيرفر مو موجود';
    if (/fetch failed|ENOTFOUND|ECONN|network/i.test(m)) return 'ما فيه اتصال بالإنترنت';
    return m.slice(0, 160); }
  async function token() {
    const a = account();
    if (a.idToken && a.exp > Date.now() + 60000) return a.idToken;
    if (!a.refresh) throw new Error('سجّل دخولك بحساب Premium Studio أول');
    const j = await post((process.env.BF_TEST_TOK || 'https://securetoken.googleapis.com') + `/v1/token?key=${API_KEY}`, { grant_type: 'refresh_token', refresh_token: a.refresh }, true);
    a.idToken = j.id_token; a.exp = Date.now() + (+j.expires_in || 3600) * 1000; a.uid = j.user_id || a.uid;
    if (j.refresh_token && j.refresh_token !== a.refresh) { a.refresh = j.refresh_token; const own = rd(AUTH_FILE); if (own) wr(AUTH_FILE, { ...own, refresh: a.refresh }); }
    return a.idToken;
  }
  async function signIn(email, pass) {
    throw new Error('سجّل دخولك في تطبيق Premium Studio وافتح اللعبة منه');
    const j = await post((process.env.BF_TEST_TOK || 'https://identitytoolkit.googleapis.com') + `/v1/accounts:signInWithPassword?key=${API_KEY}`, { email, password: pass, returnSecureToken: true });
    const u = await fsGet(`users/${j.localId}`, j.idToken).catch(() => null), d = u ? dec(u) : {};
    wr(AUTH_FILE, { uid: j.localId, email: j.email, username: d.username || '', name: d.name || '', pid: d.pid || '', refresh: j.refreshToken });
    A = null; const a = account(); a.idToken = j.idToken; a.exp = Date.now() + (+j.expiresIn || 3600) * 1000; return pub();
  }
  // the host checks a joining player's sign-in token with Google, then that the username belongs to that account
  async function verify(tok, name) {
    if (!tok) throw new Error('ما فيه تسجيل دخول');
    const j = await post((process.env.BF_TEST_TOK || 'https://identitytoolkit.googleapis.com') + `/v1/accounts:lookup?key=${API_KEY}`, { idToken: String(tok) });
    const uid = j.users && j.users[0] && j.users[0].localId; if (!uid) throw new Error('الحساب غير صالح');
    const un = String(name || '').toLowerCase().trim(); let owner = null;
    try { owner = dec(await fsGet(`usernames/${encodeURIComponent(un)}`, false)).uid; } catch (e) {}
    if (owner !== uid) throw new Error('اسم المستخدم ما يطابق الحساب');
    return { uid, username: un };
  }
  function signOut() { try { fs.rmSync(AUTH_FILE, { force: true }); } catch (e) {} A = null; return pub(); }

  // ================= Firestore REST =================
  const enc = v => {
    if (v === null || v === undefined) return { nullValue: null };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  };
  const decv = x => {
    if (!x) return null; if ('nullValue' in x) return null; if ('booleanValue' in x) return x.booleanValue;
    if ('integerValue' in x) return +x.integerValue; if ('doubleValue' in x) return x.doubleValue; if ('stringValue' in x) return x.stringValue;
    if ('timestampValue' in x) return Date.parse(x.timestampValue); if ('arrayValue' in x) return (x.arrayValue.values || []).map(decv);
    if ('mapValue' in x) return Object.fromEntries(Object.entries(x.mapValue.fields || {}).map(([k, y]) => [k, decv(y)])); return null;
  };
  const dec = doc => Object.assign(Object.fromEntries(Object.entries(doc.fields || {}).map(([k, y]) => [k, decv(y)])), { _id: doc.name.split('/').pop(), _ut: doc.updateTime });
  const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
  async function call(method, url, body, tok) {
    const t = tok === false ? null : (tok || await token());
    const r = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(errText((j.error && (j.error.status || j.error.message)) || r.status)); return j;
  }
  const fsGet = (p, tok) => call('GET', `${FS}/${p}`, null, tok);
  const qpath = k => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + k.replace(/`/g, '\\`') + '`';
  async function patch(p, obj, mask, pre) {
    const m = (mask || Object.keys(obj)).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k.split('.').map(qpath).join('.'))).join('&');
    const nested = {}; for (const [k, v] of Object.entries(obj)) { const ks = k.split('.'); let o = nested; ks.slice(0, -1).forEach(x => { o = o[x] = o[x] || {}; }); o[ks[ks.length - 1]] = v; }
    return call('PATCH', `${FS}/${p}?${m}${pre ? '&currentDocument.updateTime=' + encodeURIComponent(pre) : ''}`, { fields: fields(nested) });
  }
  async function commit(writes) { return call('POST', `${FS}:commit`, { writes }); }
  const docName = p => `projects/${PROJECT}/databases/(default)/documents/${p}`;
  async function query(where, limit) {
    const j = await call('POST', `${FS}:runQuery`, { structuredQuery: { from: [{ collectionId: COL }], where, limit: limit || 60 } });
    return (Array.isArray(j) ? j : []).filter(x => x.document).map(x => dec(x.document));
  }

  // ================= servers =================
  const now = () => Date.now();
  const CODE_A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const mkCode = () => { let s = ''; const b = crypto.randomBytes(8); for (let i = 0; i < 8; i++) s += CODE_A[b[i] % CODE_A.length]; return s; };
  const plan = s => s.plan === 'paid' && s.paidUntil && s.paidUntil > now() ? 'paid' : 'free';
  const online = s => !!(s.host && s.host.beat && now() - s.host.beat < STALE_MS);
  function view(s) {
    const a = account(), me = (s.members || {})[a.uid] || null, role = me ? me.role : null;
    return { id: s._id, name: s.name, desc: s.desc || '', code: s.code, public: !!s.public, max: s.max || 8, mode: s.mode || 's', seed: s.seed || 0,
      owner: s.ownerName || '', plan: plan(s), planRaw: s.plan || 'free', paidUntil: s.paidUntil || null, created: s.created || 0, worldVer: s.worldVer || 0, worldSize: s.worldSize || 0,
      online: online(s), host: online(s) ? { name: s.host.name, players: s.host.players || 0, list: s.host.list || [], ver: s.host.ver || '' } : null,
      members: Object.entries(s.members || {}).map(([uid, m]) => ({ uid, name: m.name, role: m.role, at: m.at || 0 })).sort((x, y) => ROLES.indexOf(x.role) - ROLES.indexOf(y.role) || String(x.name).localeCompare(y.name)),
      bans: s.bans || [], myRole: role, perms: role ? PERMS[role] : {}, _ut: s._ut };
  }
  async function mine() { const a = account(); await token(); return (await query({ fieldFilter: { field: { fieldPath: 'memberIds' }, op: 'ARRAY_CONTAINS', value: { stringValue: a.uid } } })).map(view); }
  async function publics() { return (await query({ fieldFilter: { field: { fieldPath: 'public' }, op: 'EQUAL', value: { booleanValue: true } } }, 80)).map(view); }
  async function getS(id) { return dec(await fsGet(`${COL}/${id}`)); }
  async function mustRole(id, perm) { const s = await getS(id), r = ((s.members || {})[account().uid] || {}).role; if (!can(r, perm)) throw new Error('ما عندك صلاحية لهذا'); return s; }

  const clean = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
  async function create(o) {
    const a = account(); await token(); if (!a.username) throw new Error('حسابك ما فيه اسم مستخدم');
    const mineNow = (await mine()).filter(s => s.myRole === 'owner'); if (mineNow.length >= 5) throw new Error('الحد ٥ سيرفرات لكل حساب');
    const id = crypto.randomBytes(10).toString('hex'), t = new Date();
    const doc = { name: clean(o.name, 32) || 'سيرفر ' + a.username, desc: clean(o.desc, 160), code: mkCode(), public: o.public !== false, max: Math.max(2, Math.min(20, o.max | 0 || 8)), mode: o.mode === 'c' ? 'c' : 's',
      seed: (o.seed | 0) || Math.floor(Math.random() * 1e9), owner: a.uid, ownerName: a.username, members: { [a.uid]: { name: a.username, role: 'owner', at: t } }, memberIds: [a.uid],
      plan: 'free', paidUntil: null, host: null, worldVer: 0, worldSize: 0, worldParts: 0, bans: [], created: t, updated: t };
    await call('POST', `${FS}/${COL}?documentId=${id}`, { fields: fields(doc) });
    return view(await getS(id));
  }
  async function settings(id, o) {
    await mustRole(id, 'settings'); const u = { updated: new Date() };
    if ('name' in o) u.name = clean(o.name, 32) || 'سيرفر'; if ('desc' in o) u.desc = clean(o.desc, 160); if ('public' in o) u.public = !!o.public;
    if ('max' in o) u.max = Math.max(2, Math.min(20, o.max | 0)); if ('mode' in o) u.mode = o.mode === 'c' ? 'c' : 's';
    await patch(`${COL}/${id}`, u); return view(await getS(id));
  }
  async function newCode(id) { await mustRole(id, 'settings'); await patch(`${COL}/${id}`, { code: mkCode(), updated: new Date() }); return view(await getS(id)); }
  async function addMember(id, username, role) {
    const s = await mustRole(id, 'members'); const myR = s.members[account().uid].role; role = ROLES.includes(role) && role !== 'owner' ? role : 'member';
    if (role === 'admin' && myR !== 'owner') throw new Error('بس المالك يقدر يعين مدير');
    const un = String(username || '').trim().toLowerCase().replace(/^@/, ''); if (!/^[a-z0-9_.]{3,20}$/.test(un)) throw new Error('اسم المستخدم غلط');
    let uid; try { uid = dec(await fsGet(`usernames/${un}`)).uid; } catch (e) { throw new Error('ما فيه حساب بهذا الاسم'); }
    if (s.members[uid]) throw new Error('هذا اللاعب موجود في الفريق');
    if (Object.keys(s.members).length >= 30) throw new Error('الحد ٣٠ عضو');
    await commit([{ update: { name: docName(`${COL}/${id}`), fields: fields({ members: { [uid]: { name: un, role, at: new Date() } } }) }, updateMask: { fieldPaths: [`members.${qpath(uid)}`] },
      updateTransforms: [{ fieldPath: 'memberIds', appendMissingElements: { values: [{ stringValue: uid }] } }] }]);
    return view(await getS(id));
  }
  async function setRole(id, uid, role) {
    const s = await mustRole(id, 'roles'), myR = s.members[account().uid].role, m = s.members[uid]; if (!m) throw new Error('مو عضو');
    if (!ROLES.includes(role)) throw new Error('رتبة غلط');
    if (m.role === 'owner' || role === 'owner') throw new Error('استخدم «نقل الملكية»');
    if (myR !== 'owner' && (m.role === 'admin' || role === 'admin')) throw new Error('بس المالك يقدر يغيّر المدراء');
    await patch(`${COL}/${id}`, { [`members.${uid}.role`]: role }); return view(await getS(id));
  }
  async function removeMember(id, uid) {
    const a = account(), s = await getS(id), me = (s.members || {})[a.uid], m = (s.members || {})[uid]; if (!m) return view(s);
    const self = uid === a.uid;
    if (m.role === 'owner') throw new Error(self ? 'المالك ما يقدر يطلع، انقل الملكية أو احذف السيرفر' : 'ما تقدر تشيل المالك');
    if (!self && !(me && can(me.role, 'members') && (me.role === 'owner' || m.role !== 'admin'))) throw new Error('ما عندك صلاحية لهذا');
    await commit([{ update: { name: docName(`${COL}/${id}`), fields: {} }, updateMask: { fieldPaths: [`members.${qpath(uid)}`] },
      updateTransforms: [{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: uid }] } }] }]);
    return self ? null : view(await getS(id));
  }
  async function transfer(id, uid) {
    const s = await mustRole(id, 'transfer'), m = s.members[uid]; if (!m) throw new Error('لازم يكون عضو في الفريق');
    await patch(`${COL}/${id}`, { owner: uid, ownerName: m.name, [`members.${uid}.role`]: 'owner', [`members.${account().uid}.role`]: 'admin' }); return view(await getS(id));
  }
  async function ban(id, name, on) {
    const s = await mustRole(id, 'ban'); name = String(name || '').trim().toLowerCase().slice(0, 20); if (!name) return view(s);
    const b = new Set(s.bans || []); on ? b.add(name) : b.delete(name); await patch(`${COL}/${id}`, { bans: [...b] }); return view(await getS(id));
  }
  async function remove(id) {
    const s = await mustRole(id, 'del');
    const ws = []; for (let i = 0; i < (s.worldParts || 0); i++) ws.push({ delete: docName(`${COL}/${id}/world/${i}`) });
    ws.push({ delete: docName(`${COL}/${id}`) }); await commit(ws); return true;
  }
  async function upgrade(id) { await mustRole(id, 'plan'); throw new Error('السيرفرات المدفوعة على أجهزة Premium Studio جاية قريب. سيرفرك المجاني يتحول لها بنفس عالمه وفريقه لما تفتح'); }

  // ---- running a free server on this PC
  let RUN = null;   // {id, code, beatT, list, ver}
  async function claim(id) {
    const a = account(), s = await getS(id), m = (s.members || {})[a.uid];
    if (!m || !can(m.role, 'start')) throw new Error('رتبتك ما تسمح بتشغيل السيرفر');
    if (plan(s) === 'paid') throw new Error('هذا السيرفر شغال على سيرفرات Premium Studio');
    if (online(s) && s.host.uid !== a.uid) throw new Error(`السيرفر شغال الحين عند ${s.host.name}`);
    await patch(`${COL}/${id}`, { host: { uid: a.uid, name: a.username, beat: new Date(), players: 0, list: [], ver: '' } }, ['host'], s._ut);
    RUN = { id, code: s.code, list: [], ver: '' }; startBeat();
    return { s: view(await getS(id)), world: s.worldVer ? await downloadWorld(id, s) : null, bans: s.bans || [] };
  }
  function startBeat() { stopBeat(); RUN.t = setInterval(() => beat().catch(() => {}), BEAT_MS); }
  function stopBeat() { if (RUN && RUN.t) clearInterval(RUN.t); }
  async function beat() { if (!RUN) return; await patch(`${COL}/${RUN.id}`, { 'host.beat': new Date(), 'host.players': RUN.list.length, 'host.list': RUN.list.slice(0, 20), 'host.ver': RUN.ver }); }
  function status(st) { if (!RUN) return; RUN.list = (st.players || []).map(x => String(x).slice(0, 20)); RUN.ver = String(st.ver || '').slice(0, 12); }
  async function release() { if (!RUN) return; const id = RUN.id; stopBeat(); RUN = null; try { await patch(`${COL}/${id}`, { host: null }, ['host']); } catch (e) {} }
  async function uploadWorld(id, json) {
    const s = await getS(id), m = (s.members || {})[account().uid]; if (!m || !can(m.role, 'start')) throw new Error('ما عندك صلاحية لهذا');
    const b64 = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64'); const parts = Math.ceil(b64.length / PART) || 1;
    if (parts > 12) throw new Error('العالم كبير مرة على الحفظ السحابي');
    const v = (s.worldVer || 0) + 1, ws = [];
    for (let i = 0; i < parts; i++) ws.push({ update: { name: docName(`${COL}/${id}/world/${i}`), fields: fields({ d: b64.slice(i * PART, (i + 1) * PART), v }) } });
    for (let i = parts; i < (s.worldParts || 0); i++) ws.push({ delete: docName(`${COL}/${id}/world/${i}`) });
    ws.push({ update: { name: docName(`${COL}/${id}`), fields: fields({ worldVer: v, worldSize: json.length, worldParts: parts, updated: new Date() }) }, updateMask: { fieldPaths: ['worldVer', 'worldSize', 'worldParts', 'updated'] } });
    for (let i = 0; i < ws.length; i += 4) await commit(ws.slice(i, i + 4));   // a few parts per request
    return v;
  }
  async function downloadWorld(id, s) {
    s = s || await getS(id); if (!s.worldVer) return null; let b64 = '';
    for (let i = 0; i < (s.worldParts || 0); i++) { const d = dec(await fsGet(`${COL}/${id}/world/${i}`)); if (d.v !== s.worldVer) throw new Error('نسخة العالم تتحدث الحين، جرب بعد شوي'); b64 += d.d; }
    return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  }
  // the latest copy of each server world is also kept on this PC (so a start works even if the upload failed last time)
  const localW = id => path.join(GAMEDIR, 'servers', id + '.json');
  function saveLocal(id, json) { try { fs.mkdirSync(path.dirname(localW(id)), { recursive: true }); fs.writeFileSync(localW(id), json); } catch (e) {} }

  // ================= IPC =================
  // put one of your own worlds into the server (it then becomes the server's world)
  async function importWorld(id, json) { let j = null; try { j = JSON.parse(json); } catch (e) {} if (!j || j.v !== 5) throw new Error('هذا العالم ما ينقرى');
    const s = await getS(id); if (online(s)) throw new Error('وقّف السيرفر أول، بعدين انقل العالم'); const v = await uploadWorld(id, json); saveLocal(id, json); return v; }
  const H = (ch, f) => ipcMain.handle(ch, async (e, ...a) => { try { return { ok: true, v: await f(...a) }; } catch (err) { return { ok: false, err: err.message || String(err) }; } });
  H('ps-account', () => pub());
  H('ps-signin', (em, pw) => signIn(String(em || '').trim(), String(pw || '')));
  H('ps-signout', () => signOut());
  H('ps-idtoken', () => token());
  H('ps-verify', (tok, name) => verify(tok, name));
  H('srv-mine', () => mine());
  H('srv-public', () => publics());
  H('srv-list', async () => { const a = account(), out = new Map(); for (const s of await publics().catch(() => [])) out.set(s.id, s); if (a.refresh) for (const s of await mine().catch(() => [])) out.set(s.id, s); return [...out.values()].filter(s => !(s.bans || []).includes(a.username)); });
  H('srv-get', id => getS(id).then(view));
  H('srv-import', (id, json) => importWorld(id, String(json || '')));
  H('srv-create', o => create(o || {}));
  H('srv-settings', (id, o) => settings(id, o || {}));
  H('srv-code', id => newCode(id));
  H('srv-add', (id, un, role) => addMember(id, un, role));
  H('srv-role', (id, uid, role) => setRole(id, uid, role));
  H('srv-kickm', (id, uid) => removeMember(id, uid));
  H('srv-transfer', (id, uid) => transfer(id, uid));
  H('srv-ban', (id, name, on) => ban(id, name, on));
  H('srv-delete', id => remove(id));
  H('srv-upgrade', id => upgrade(id));
  H('srv-running', () => RUN ? { id: RUN.id } : null);
  return {
    account: pub, can, PERMS,
    token, uid: () => account().uid,   // for premium.js (cloud saves, achievements)
    // called by main.js around the game window
    async startHosting(id) { const r = await claim(id); let world = r.world; if (!world) { try { world = fs.readFileSync(localW(id), 'utf8'); } catch (e) { world = null; } } else saveLocal(id, world); return { s: r.s, world, bans: r.bans }; },
    status, release, running: () => RUN && RUN.id,
    async save(id, json) { saveLocal(id, json); return uploadWorld(id, json); },
    async info(id) { return view(await getS(id)); }
  };
};
