const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lydia', {
  on: (channel, fn) => {
    if (['state', 'stats', 'cursor', 'geometry', 'look', 'demo', 'layout', 'prefs', 'chat', 'view'].includes(channel)) {
      ipcRenderer.on(channel, (_e, payload) => fn(payload));
    }
  },
  menu: () => ipcRenderer.send('menu'),
  editMenu: () => ipcRenderer.send('edit-menu'),
  clipboardText: () => ipcRenderer.invoke('clipboard-text'),
  togglePause: () => ipcRenderer.send('toggle-pause'),
  action: (id) => ipcRenderer.send('action', id),
  setLook: (look) => ipcRenderer.send('set-look', look),
  setPref: (key, value) => ipcRenderer.send('set-pref', key, value),
  setView: (view) => ipcRenderer.send('view', view),
  collapse: () => ipcRenderer.send('collapse'),
  hover: (on) => ipcRenderer.send('hover', on),
  news: (on) => ipcRenderer.send('news', on),
  chatFocus: () => ipcRenderer.send('chat-focus'),
  chatSend: (text) => ipcRenderer.send('chat-send', text),
  chatNew: () => ipcRenderer.send('chat-new'),
  chatInfo: () => ipcRenderer.invoke('chat-info'),
  chatProvider: (p) => ipcRenderer.invoke('chat-provider', p),
  chatModel: (m) => ipcRenderer.invoke('chat-model', m),
  geminiKey: (key) => ipcRenderer.invoke('gemini-key', key),
  openKeyPage: () => ipcRenderer.send('open-key-page'),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  tasks: (by) => ipcRenderer.invoke('tasks', by),
  taskKill: (name) => ipcRenderer.invoke('task-kill', name),
  setupStatus: () => ipcRenderer.invoke('setup-status'),
  setupClaudeLogin: () => ipcRenderer.invoke('setup-claude-login'),
  setupOllamaPull: () => ipcRenderer.invoke('setup-ollama-pull'),
  setupExtInstall: () => ipcRenderer.invoke('setup-ext-install'),
  setupAutostart: (on) => ipcRenderer.invoke('setup-autostart', on),
  setupDone: () => ipcRenderer.send('setup-done'),
});
