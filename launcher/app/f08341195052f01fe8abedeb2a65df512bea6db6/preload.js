// tells the launcher page it runs as the Windows desktop app, and gives the game its network
const { contextBridge, ipcRenderer } = require('electron');
const listeners = [];
ipcRenderer.on('net-ev', (e, ev) => { for (const f of listeners) { try { f(ev); } catch (err) {} } });
const progL = []; ipcRenderer.on('cdn-prog', (e, id, p) => { for (const f of progL) { try { f(id, p); } catch (err) {} } });
contextBridge.exposeInMainWorld('TVDESK', {
  game: {
    launch: (id, o) => ipcRenderer.invoke('game-launch', id, o || {}),
    running: () => ipcRenderer.invoke('game-running'),
    exit: () => ipcRenderer.send('game-exit'),
    fullscreen: on => ipcRenderer.send('game-fullscreen', !!on),
    nick: () => { try { return new URLSearchParams(location.search).get('nick') || 'Player'; } catch (e) { return 'Player'; } },
    onClosed: f => ipcRenderer.on('game-closed', (e, info) => f(info)),
    onLog: f => ipcRenderer.on('game-log', (e, m) => f(m))
  },
  cdn: {
    remove: id => ipcRenderer.invoke('cdn-delete', id),
    sizes: () => ipcRenderer.invoke('cdn-sizes'),
    manifest: fresh => ipcRenderer.invoke('cdn-manifest', !!fresh),
    installed: () => ipcRenderer.invoke('cdn-installed'),
    install: (id, force) => ipcRenderer.invoke('cdn-install', id, !!force),
    info: () => ipcRenderer.invoke('cdn-info'),
    folder: () => ipcRenderer.invoke('cdn-folder'),
    onProgress: f => { progL.length = 0; progL.push(f); }
  },
  lic: {
    get: () => ipcRenderer.invoke('lic-get'),
    validate: () => ipcRenderer.invoke('lic-validate'),
    activate: key => ipcRenderer.invoke('lic-activate', key),
    remove: () => ipcRenderer.invoke('lic-remove')
  },
  // Premium Games account + BLOCKFALL servers
  ps: {
    account: () => ipcRenderer.invoke('ps-account'),
    signIn: (email, pass) => ipcRenderer.invoke('ps-signin', email, pass),
    signOut: () => ipcRenderer.invoke('ps-signout'),
    idToken: () => ipcRenderer.invoke('ps-idtoken'),
    verify: (tok, name) => ipcRenderer.invoke('ps-verify', tok, name),
    editions: () => ipcRenderer.invoke('ps-editions'),
    setEdition: ed => ipcRenderer.invoke('ps-set-edition', ed)
  },
  srv: {
    mine: () => ipcRenderer.invoke('srv-mine'), list: () => ipcRenderer.invoke('srv-list'), get: id => ipcRenderer.invoke('srv-get', id),
    create: o => ipcRenderer.invoke('srv-create', o), settings: (id, o) => ipcRenderer.invoke('srv-settings', id, o), newCode: id => ipcRenderer.invoke('srv-code', id),
    add: (id, un, role) => ipcRenderer.invoke('srv-add', id, un, role), role: (id, uid, role) => ipcRenderer.invoke('srv-role', id, uid, role),
    removeMember: (id, uid) => ipcRenderer.invoke('srv-kickm', id, uid), transfer: (id, uid) => ipcRenderer.invoke('srv-transfer', id, uid),
    ban: (id, name, on) => ipcRenderer.invoke('srv-ban', id, name, !!on), del: id => ipcRenderer.invoke('srv-delete', id), upgrade: id => ipcRenderer.invoke('srv-upgrade', id), importWorld: (id, json) => ipcRenderer.invoke('srv-import', id, json),
    running: () => ipcRenderer.invoke('srv-running'), stop: () => ipcRenderer.invoke('srv-stop'), local: () => ipcRenderer.invoke('srv-local'), onLocal: f => ipcRenderer.on('srv-local', (e, st) => f(st)), start: (id, ver, o) => ipcRenderer.invoke('srv-start', id, ver, o || {}),
    boot: () => ipcRenderer.invoke('srv-boot'), status: st => ipcRenderer.send('srv-status', st), save: (json, final) => ipcRenderer.invoke('srv-save', json, !!final),
    onFinal: f => ipcRenderer.on('srv-final', () => f())
  },
  edition: () => { try { return new URLSearchParams(location.search).get('ed') || ''; } catch (e) { return ''; } },
  platform: process.platform,
  quit: () => ipcRenderer.send('tv-quit'),
  fullscreen: on => ipcRenderer.send('tv-fullscreen', !!on),
  net: {
    host: o => ipcRenderer.invoke('net-host', o),
    stop: () => ipcRenderer.send('net-stop'),
    kick: (id, why) => ipcRenderer.send('net-kick', id, why),
    send: (to, d) => ipcRenderer.send('net-send', to, d),
    join: a => ipcRenderer.invoke('net-join', a),
    leave: () => ipcRenderer.send('net-leave'),
    lan: () => ipcRenderer.invoke('net-lan'),
    on: f => { listeners.length = 0; listeners.push(f); }
  }
});
