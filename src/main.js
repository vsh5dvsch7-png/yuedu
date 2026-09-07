const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
if (process.env.NR_DATA_DIR) app.setPath('userData', process.env.NR_DATA_DIR);

const ASSETS = path.join(__dirname, '..', 'assets');
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function saveState(st) { try { fs.writeFileSync(stateFile(), JSON.stringify(st)); } catch {} }

function createWindow() {
  const st = loadState();
  const w = new BrowserWindow({
    width: st.width || 1000, height: st.height || 760, x: st.x, y: st.y,
    title: '月读', icon: path.join(ASSETS, 'icon.png'), autoHideMenuBar: true, backgroundColor: '#f7f3e8',
    webPreferences: { contextIsolation: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') }
  });
  Menu.setApplicationMenu(null);
  if (st.maximized) w.maximize();
  w.loadFile(path.join(__dirname, 'index.html'));
  w.on('close', () => saveState({ ...w.getNormalBounds(), maximized: w.isMaximized() }));
}

function decodeTxt(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('gbk').decode(buf); }
}
const importFile = (name, buf) => ({ name: name.replace(/\.txt$/i, ''), text: decodeTxt(buf) });
ipcMain.handle('import:dialog', async e => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'], filters: [{ name: '文本文件', extensions: ['txt'] }] });
  if (r.canceled) return [];
  return r.filePaths.map(p => { try { return importFile(path.basename(p), fs.readFileSync(p)); } catch (err) { return { error: path.basename(p) + '：' + err.message }; } });
});
ipcMain.handle('import:buffer', (e, { name, data }) => importFile(name, Buffer.from(data)));
ipcMain.on('open-url', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('donate:images', () => {
  const out = {};
  for (const [k, f] of [['wechat', 'wechat.png'], ['alipay', 'alipay.png'], ['any', 'donate.png']]) {
    const p = path.join(ASSETS, f);
    if (fs.existsSync(p)) out[k] = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  }
  return out;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
