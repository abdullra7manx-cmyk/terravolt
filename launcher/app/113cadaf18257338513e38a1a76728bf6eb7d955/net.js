// TERRAVOLT networking for the desktop app (main process).
// host: a WebSocket server the friends connect to; the host's game talks to it through IPC.
// join: a WebSocket client to someone's host, relayed to the game through IPC.
// LAN: every open game shouts a small UDP beacon on the local network, so others see it in the list.
// UPnP: asks the router to open the port so friends can join from the internet.
'use strict';
const os = require('os'), dgram = require('dgram'), http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const LAN_PORT = 47777;

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || [])
    if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
    out.add(ip.map((v, i) => (v & m[i]) | (~m[i] & 255)).join('.'));
  }
  return [...out];
}

// ---- minimal UPnP (IGD) port mapping, no extra packages
function httpReq(url, body, headers) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: body ? 'POST' : 'GET', headers: headers || {}, timeout: 4000 }, rs => {
      let d = ''; rs.setEncoding('utf8'); rs.on('data', c => { d += c; if (d.length > 2e6) r.destroy(); }); rs.on('end', () => res({ status: rs.statusCode, body: d }));
    });
    r.on('error', rej); r.on('timeout', () => r.destroy(new Error('timeout'))); if (body) r.write(body); r.end();
  });
}
function ssdp() {
  return new Promise(res => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); const found = new Set(); let done = false;
    const fin = () => { if (done) return; done = true; try { s.close(); } catch (e) {} res([...found]); };
    s.on('message', m => { const l = /LOCATION:\s*(\S+)/i.exec(m.toString()); if (l) found.add(l[1]); });
    s.on('error', fin);
    s.bind(() => {
      const q = (st) => Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'])
        s.send(q(st), 1900, '239.255.255.250', () => {});
    });
    setTimeout(fin, 2500);
  });
}
async function upnpService() {
  for (const loc of await ssdp()) {
    try {
      const { body } = await httpReq(loc);
      const re = /<service>([\s\S]*?)<\/service>/g; let m;
      while ((m = re.exec(body))) {
        const t = /<serviceType>([^<]+)<\/serviceType>/.exec(m[1]), c = /<controlURL>([^<]+)<\/controlURL>/.exec(m[1]);
        if (t && c && /WAN(IP|PPP)Connection/.test(t[1])) return { type: t[1].trim(), url: new URL(c[1].trim(), loc).toString(), lan: new URL(loc).hostname };
      }
    } catch (e) {}
  }
  return null;
}
async function soap(svc, action, args) {
  const a = Object.entries(args || {}).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${a}</u:${action}></s:Body></s:Envelope>`;
  return httpReq(svc.url, body, { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"`, 'Content-Length': Buffer.byteLength(body) });
}
function myIpFor(gw) { const g = (gw || '').split('.').slice(0, 3).join('.'); return localIPs().find(i => i.startsWith(g + '.')) || localIPs()[0]; }
async function upnpOpen(port) {
  try {
    const svc = await upnpService(); if (!svc) return { ok: false, err: 'no-router' };
    const r = await soap(svc, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: myIpFor(svc.lan), NewEnabled: 1, NewPortMappingDescription: 'TERRAVOLT', NewLeaseDuration: 0 });
    if (r.status !== 200) return { ok: false, err: 'refused' };
    let ext = ''; try { const e = await soap(svc, 'GetExternalIPAddress', {}); const m = /<NewExternalIPAddress>([^<]*)</.exec(e.body); if (m) ext = m[1]; } catch (e) {}
    return { ok: true, ext, svc };
  } catch (e) { return { ok: false, err: e.message }; }
}
async function upnpClose(svc, port) { try { if (svc) await soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }); } catch (e) {} }

// ---- the network core, independent of Electron (also used by the tests and later by the dedicated server)
function createNet(emit) {
  const st = { wss: null, clients: new Map(), nextId: 1, info: null, beacon: null, lanSock: null, lan: new Map(), ws: null, upnp: null, port: 0 };
  function lanListen() {
    if (st.lanSock) return;
    try {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); st.lanSock = s;
      s.on('message', (m, r) => { try { const d = JSON.parse(m.toString()); if (d && d.tv === 1 && d.port) st.lan.set(r.address + ':' + d.port, Object.assign({}, d, { ip: r.address, seen: Date.now() })); } catch (e) {} });
      s.on('error', () => { try { s.close(); } catch (e) {} st.lanSock = null; });
      s.bind(LAN_PORT, () => { try { s.setBroadcast(true); } catch (e) {} });
    } catch (e) { st.lanSock = null; }
  }
  function beacon() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.bind(() => { try { s.setBroadcast(true); } catch (e) {} });
    const send = () => {
      if (!st.info) return; const i = st.info;
      const msg = Buffer.from(JSON.stringify({ tv: 1, name: i.name, host: i.host, world: i.world, mode: i.mode, ver: i.ver, port: st.port, players: 1 + [...st.clients.values()].filter(c => c.ok).length, max: i.max, pass: !!i.pass }));
      for (const a of broadcastAddrs().concat(['127.0.0.1'])) s.send(msg, LAN_PORT, a, () => {});
    };
    send(); const t = setInterval(send, 1500);
    return { stop() { clearInterval(t); try { s.close(); } catch (e) {} } };
  }
  return {
    async host(opts) {
      if (st.wss) this.stop();
      const port = Math.max(1024, Math.min(65535, opts.port | 0 || 47800));
      try {
        await new Promise((res, rej) => {
          const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 * 1024, perMessageDeflate: { threshold: 4096 } });
          wss.once('listening', () => { st.wss = wss; res(); }); wss.once('error', rej);
        });
      } catch (e) { return { ok: false, err: e.code === 'EADDRINUSE' ? `المنفذ ${port} مستخدم، جرّب منفذ ثاني` : e.message }; }
      st.port = port; st.info = { name: String(opts.name || 'TERRAVOLT').slice(0, 40), host: String(opts.host || '').slice(0, 20), world: String(opts.world || '').slice(0, 40), mode: opts.mode, ver: opts.ver, max: opts.max | 0 || 8, pass: !!opts.pass };
      st.wss.on('connection', (ws, req) => {
        const id = st.nextId++; const c = { id, ws, ok: true, ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, '') }; st.clients.set(id, c);
        ws.on('message', (data, bin) => { if (bin) return; emit({ ev: 'msg', from: id, d: data.toString() }); });
        ws.on('close', () => { st.clients.delete(id); emit({ ev: 'leave', id }); });
        ws.on('error', () => {});
        emit({ ev: 'join', id, ip: c.ip });
      });
      st.beacon = beacon();
      let upnp = { ok: false };
      if (opts.pub) { upnp = await upnpOpen(port); st.upnp = upnp.ok ? upnp.svc : null; }
      return { ok: true, port, ips: localIPs(), upnp: { ok: upnp.ok, ext: upnp.ext || '', err: upnp.err || '' } };
    },
    stop() {
      if (st.beacon) { st.beacon.stop(); st.beacon = null; }
      for (const c of st.clients.values()) { try { c.ws.close(4000, 'host-left'); } catch (e) {} }
      st.clients.clear();
      if (st.wss) { try { st.wss.close(); } catch (e) {} st.wss = null; }
      if (st.upnp) { upnpClose(st.upnp, st.port); st.upnp = null; }
      st.info = null;
    },
    send(to, d) {
      if (st.ws) { if (st.ws.readyState === 1) st.ws.send(d); return; }
      if (!st.wss) return;
      if (to === 0 || to === '*') { for (const c of st.clients.values()) if (c.ws.readyState === 1) c.ws.send(d); return; }
      const c = st.clients.get(to); if (c && c.ws.readyState === 1) c.ws.send(d);
    },
    kick(id, why) { const c = st.clients.get(id); if (c) { try { c.ws.close(4001, String(why || 'kick').slice(0, 100)); } catch (e) {} } },
    join(addr) {
      this.leave();
      return new Promise(res => {
        let done = false; const fin = r => { if (!done) { done = true; res(r); } };
        let ws; try { ws = new WebSocket('ws://' + addr, { handshakeTimeout: 6000, maxPayload: 256 * 1024 * 1024 }); } catch (e) { fin({ ok: false, err: e.message }); return; }
        st.ws = ws;
        ws.on('open', () => fin({ ok: true }));
        ws.on('message', (data, bin) => { if (!bin) emit({ ev: 'msg', from: 0, d: data.toString() }); });
        ws.on('close', (code, reason) => { if (st.ws === ws) st.ws = null; const r = reason ? reason.toString() : ''; if (!done) fin({ ok: false, err: 'ما يرد' }); else emit({ ev: 'closed', why: code === 4000 ? 'صاحب اللعبة قفلها' : code === 4001 ? r : 'انقطع الاتصال' }); });
        ws.on('error', e => { fin({ ok: false, err: e.code === 'ECONNREFUSED' ? 'ما فيه لعبة مفتوحة على هذا العنوان' : e.code === 'ETIMEDOUT' ? 'العنوان ما يرد' : e.message }); });
      });
    },
    leave() { if (st.ws) { const w = st.ws; st.ws = null; try { w.close(1000); } catch (e) {} } },
    lan() { lanListen(); const now = Date.now(); const by = new Map(); const mine = localIPs().concat(['127.0.0.1']);
      for (const [k, g] of st.lan) { if (now - g.seen > 5000) { st.lan.delete(k); continue; } if (st.wss && g.port === st.port && mine.includes(g.ip)) continue;
        const key = g.name + '|' + g.host + '|' + g.port, o = by.get(key); if (!o || (o.ip === '127.0.0.1' && g.ip !== '127.0.0.1')) by.set(key, g); }
      return [...by.values()]; },
    shutdown() { this.leave(); this.stop(); if (st.lanSock) { try { st.lanSock.close(); } catch (e) {} st.lanSock = null; } }
  };
}

function setupIPC(ipcMain, getWin) {
  const net = createNet(ev => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('net-ev', ev); });
  ipcMain.handle('net-host', (e, o) => net.host(o || {}));
  ipcMain.handle('net-join', (e, a) => net.join(String(a || '')));
  ipcMain.handle('net-lan', () => net.lan());
  ipcMain.on('net-stop', () => net.stop());
  ipcMain.on('net-leave', () => net.leave());
  ipcMain.on('net-send', (e, to, d) => net.send(to, d));
  ipcMain.on('net-kick', (e, id, why) => net.kick(id, why));
  return net;
}
module.exports = { createNet, setupIPC, localIPs };
