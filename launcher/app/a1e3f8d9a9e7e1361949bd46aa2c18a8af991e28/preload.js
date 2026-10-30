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
