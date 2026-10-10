/* Exposes a tiny `window.desktop` API to the game; its presence is how the page knows it is the desktop build. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  quit: () => ipcRenderer.send('quit'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  version: ipcRenderer.sendSync('version') // shown in the main menu footer
});
