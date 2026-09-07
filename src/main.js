const { app, BrowserWindow, Menu, ipcMain, globalShortcut, Tray, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crawler = require('./crawler');
const license = require('./license');
const { epubToText } = require('./epub');
if (process.env.NR_DATA_DIR) app.setPath('userData', process.env.NR_DATA_DIR);   // 开发测试用独立数据目录

const ASSETS = path.join(__dirname, '..', 'assets');
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const rulesDir = () => path.join(app.getPath('userData'), 'rules');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function saveState(st) { try { fs.writeFileSync(stateFile(), JSON.stringify(st)); } catch {} }

let tray = null;
const mainWin = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed());

// ghost = 桌面模式：无边框、透明窗口，只显示文字浮在桌面上
function createWindow(ghost, bounds) {
  const st = loadState();
  const b = bounds || st;
  const w = new BrowserWindow({
    width: b.width || 1000, height: b.height || 760,
    x: b.x, y: b.y,
    title: '月读',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    frame: !ghost,
    transparent: !!ghost,
    hasShadow: !ghost,
    alwaysOnTop: ghost ? !!st.onTop : false,
    backgroundColor: ghost ? '#00000000' : '#f7f3e8',
    webPreferences: { contextIsolation: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') }
  });
  Menu.setApplicationMenu(null);
  if (!ghost && st.maximized) w.maximize();
  w.loadFile(path.join(__dirname, 'index.html'), { query: ghost ? { ghost: '1' } : {} });
  w.on('close', () => {
    if (w.__switching) return;                 // 切换模式时不记录（新窗口会记录）
    const nb = w.getNormalBounds();
    saveState({ ...loadState(), ...nb, maximized: !ghost && w.isMaximized(), ghost: !!ghost });
  });
  return w;
}

/* ---------- 桌面模式 / 窗口 ---------- */
ipcMain.on('set-ghost', (e, on) => {
  const old = BrowserWindow.fromWebContents(e.sender);
  const b = old.getNormalBounds();
  old.__switching = true;
  saveState({ ...loadState(), ...b, ghost: !!on, maximized: false });
  createWindow(!!on, b);
  old.close();
});
ipcMain.on('set-on-top', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  w.setAlwaysOnTop(!!on, 'floating');
  saveState({ ...loadState(), onTop: !!on });
});
ipcMain.on('set-blur', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  try { w.setBackgroundMaterial(on ? 'acrylic' : 'none'); } catch {}
});
ipcMain.on('win-cmd', (e, cmd) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (cmd === 'min') w.minimize();
  else if (cmd === 'close') w.close();
});

/* ---------- 老板键：一键隐藏 / 恢复 ---------- */
let bossKey = null;
function toggleHide() {
  const w = mainWin(); if (!w) return;
  if (w.isVisible() && !w.isMinimized()) { w.hide(); }
  else { w.show(); w.focus(); }
}
function registerBossKey(acc) {
  if (bossKey) { try { globalShortcut.unregister(bossKey); } catch {} bossKey = null; }
  saveState({ ...loadState(), bossKey: acc || '' });
  if (!acc) return { ok: true };
  try {
    const ok = globalShortcut.register(acc, toggleHide);
    if (!ok) return { ok: false, msg: '快捷键被其他程序占用' };
    bossKey = acc;
    return { ok: true };
  } catch (e) { return { ok: false, msg: '无效的快捷键' }; }
}
ipcMain.handle('boss-key', (e, acc) => license.status().pro ? registerBossKey(acc) : { ok: false, msg: '需要专业版' });
ipcMain.handle('boss-key-get', () => loadState().bossKey ?? 'Ctrl+Alt+Q');

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('月读');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: toggleHide },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]));
    tray.on('click', toggleHide);
  } catch {}
}

/* ---------- 授权 ---------- */
ipcMain.handle('license:status', () => license.status());
ipcMain.handle('license:activate', (e, code) => {
  const r = license.activate(code);
  if (r.ok) { const st = loadState(); registerBossKey(st.bossKey ?? 'Ctrl+Alt+Q'); }
  return r;
});
ipcMain.handle('license:deactivate', () => { const s = license.deactivate(); if (!s.pro) registerBossKey(''); return s; });
ipcMain.on('open-url', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

/* ---------- 导入：txt / epub ---------- */
function decodeTxt(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('gbk').decode(buf); }
}
async function importFile(name, buf) {
  if (/\.epub$/i.test(name)) {
    if (!license.status().pro) throw new Error('导入 epub 需要专业版');
    const r = await epubToText(buf);
    return { name: r.title || name.replace(/\.epub$/i, ''), author: r.author, text: r.text };
  }
  return { name: name.replace(/\.txt$/i, ''), text: decodeTxt(buf) };
}
ipcMain.handle('import:dialog', async e => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'], filters: [{ name: '电子书 (txt, epub)', extensions: ['txt', 'epub'] }] });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths) { try { out.push(await importFile(path.basename(p), fs.readFileSync(p))); } catch (err) { out.push({ error: path.basename(p) + '：' + err.message }); } }
  return out;
});
ipcMain.handle('import:buffer', async (e, { name, data }) => {
  try { return await importFile(name, Buffer.from(data)); } catch (err) { return { error: name + '：' + err.message }; }
});

/* ---------- 书源（用户自行导入，软件不内置） ---------- */
function reloadRules() { fs.mkdirSync(rulesDir(), { recursive: true }); return crawler.loadRules(rulesDir()); }
ipcMain.handle('rules:list', () => { reloadRules(); return crawler.listSources(); });
ipcMain.handle('rules:files', () => { fs.mkdirSync(rulesDir(), { recursive: true }); return fs.readdirSync(rulesDir()).filter(f => f.endsWith('.json')); });
ipcMain.handle('rules:import', async e => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'], filters: [{ name: '书源规则 (so-novel 格式 json)', extensions: ['json'] }] });
  if (r.canceled) return { ok: true, added: 0, errors: [] };
  fs.mkdirSync(rulesDir(), { recursive: true });
  let added = 0, errors = [];
  for (const p of r.filePaths) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(arr) || !arr.every(x => x && x.url)) throw new Error('不是书源规则数组');
      fs.copyFileSync(p, path.join(rulesDir(), path.basename(p))); added++;
    } catch (err) { errors.push(path.basename(p) + '：' + err.message); }
  }
  reloadRules();
  return { ok: !errors.length, added, errors };
});
ipcMain.handle('rules:delete', (e, file) => { try { fs.unlinkSync(path.join(rulesDir(), path.basename(file))); } catch {} reloadRules(); return true; });
ipcMain.on('rules:open-dir', () => { fs.mkdirSync(rulesDir(), { recursive: true }); shell.openPath(rulesDir()); });

/* ---------- 搜书 / 下载 ---------- */
ipcMain.handle('novel:search', async (e, keyword) => {
  if (!license.status().pro) throw new Error('搜书需要专业版');
  reloadRules();
  return crawler.search(keyword, s => { try { e.sender.send('novel:source-status', s); } catch {} });
});
const downloads = new Map();
ipcMain.handle('novel:download', async (e, { sourceId, url }) => {
  const rule = crawler.getRule(sourceId);
  if (!rule) throw new Error('书源不存在');
  const ctrl = new AbortController();
  downloads.set(e.sender.id, ctrl);
  try {
    let last = 0;
    return await crawler.downloadBook(rule, url, {
      signal: ctrl.signal,
      onProgress: p => { const now = Date.now(); if (now - last > 200 || p.done === p.total) { last = now; try { e.sender.send('novel:progress', p); } catch {} } }
    });
  } finally { downloads.delete(e.sender.id); }
});
ipcMain.on('novel:cancel', e => { const c = downloads.get(e.sender.id); if (c) c.abort(); });

/* ---------- 打赏图片 ---------- */
ipcMain.handle('donate:images', () => {
  const out = {};
  for (const [k, f] of [['wechat', 'wechat.png'], ['alipay', 'alipay.png'], ['any', 'donate.png']]) {
    const p = path.join(ASSETS, f);
    if (fs.existsSync(p)) out[k] = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  }
  return out;
});

app.whenReady().then(() => {
  license.init(app.getPath('userData'));
  reloadRules();
  const st = loadState();
  createWindow(!!st.ghost);
  createTray();
  if (license.status().pro) registerBossKey(st.bossKey ?? 'Ctrl+Alt+Q');
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
