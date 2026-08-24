// 恶魔连结 存档编辑器 - Electron 主进程
// 与 Tauri 后端（src-tauri/src/lib.rs）保持相同能力：listDir / readText / writeText / readResource / saveImage / pickDir / defaultStorage / resourceRoots
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron')
const fs = require('fs')
const path = require('path')

// 候选游戏资源根目录：从应用目录向上逐层查找，并加入已知路径兜底（与 Tauri resource_roots 保持一致）
function resourceRoots() {
  const roots = new Set()
  let cur = app.getAppPath()
  for (let i = 0; i < 8 && cur; i++) {
    roots.add(path.join(cur, '_Unpacked', 'app.asar_extracted'))
    roots.add(path.join(cur, 'resources', 'app.asar'))
    roots.add(cur)
    cur = path.dirname(cur)
  }
  // 可选：环境变量 DC_GAME_ROOT 指定游戏根目录（脱敏：不硬编码本机路径）
  if (process.env.DC_GAME_ROOT) {
    roots.add(path.join(process.env.DC_GAME_ROOT, '_Unpacked', 'app.asar_extracted'))
    roots.add(path.join(process.env.DC_GAME_ROOT, 'resources', 'app.asar'))
  }
  return [...roots]
}

// 用户通过界面「资源目录」额外指定的根目录，读取资源时优先查找
let userResourceRoots = []

function findResource(relPath) {
  for (const root of [...userResourceRoots, ...resourceRoots()]) {
    const p = path.join(root, relPath)
    try {
      if (fs.statSync(p).isFile()) return p
    } catch (_) {}
  }
  return null
}

// 默认存档目录：向上查找 _storage，找不到则用已知路径 / 用户主目录
function defaultStorageDir() {
  let cur = app.getAppPath()
  for (let i = 0; i < 8 && cur; i++) {
    const cand = path.join(cur, '_storage')
    try {
      if (fs.statSync(cand).isDirectory()) return cand
    } catch (_) {}
    cur = path.dirname(cur)
  }
  // 可选：环境变量 DC_GAME_ROOT 指向游戏根目录（脱敏：不硬编码本机路径）
  if (process.env.DC_GAME_ROOT) {
    const cand = path.join(process.env.DC_GAME_ROOT, '_storage')
    try {
      if (fs.statSync(cand).isDirectory()) return cand
    } catch (_) {}
  }
  return app.getPath('home')
}

let win = null

function createWindow() {
  // 适配屏幕分辨率/DPI：窗口取期望尺寸与屏幕工作区的较小值，确保 1920x1080 等屏幕上完整显示
  const wa = screen.getPrimaryDisplay().workAreaSize
  const w = Math.max(1000, Math.min(1500, wa.width - 60))
  const h = Math.max(680, Math.min(920, wa.height - 60))
  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 900,
    minHeight: 600,
    title: '恶魔连结 存档编辑器',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---------------- IPC ----------------

// 列出目录内容（仅一层），返回 [{name, dir, size, mtime, full}]
ipcMain.handle('fs:listDir', (_e, dir) => {
  const out = []
  const items = fs.readdirSync(dir, { withFileTypes: true })
  for (const it of items) {
    const full = path.join(dir, it.name)
    let size = 0
    let mtime = 0
    try {
      const st = fs.statSync(full)
      size = st.size
      mtime = st.mtimeMs
    } catch (_) {}
    out.push({ name: it.name, dir: it.isDirectory(), size, mtime, full })
  }
  return out
})

// 读取存档文件文本
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf-8'))

// 写入存档文件文本
ipcMain.handle('fs:writeText', (_e, p, text) => {
  fs.writeFileSync(p, text, 'utf-8')
  return true
})

// 读取游戏资源（返回 dataURL），relPath 形如 data/image/ui/save1.png
ipcMain.handle('res:read', (_e, relPath) => {
  const p = findResource(relPath)
  if (!p) return null
  const buf = fs.readFileSync(p)
  const ext = path.extname(p).toLowerCase()
  const mime = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream'
  return `data:${mime};base64,${buf.toString('base64')}`
})

// 导出图片（dataURL -> 文件）
ipcMain.handle('fs:saveImage', async (_e, dataUrl, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出图片',
    defaultPath: defaultName || 'photo.png',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  })
  if (canceled || !filePath) return false
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s)
  if (!m) return false
  fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'))
  return true
})

// 选择文件夹
ipcMain.handle('fs:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  return r.filePaths[0]
})

// 默认存档目录
ipcMain.handle('fs:defaultStorage', () => defaultStorageDir())

// 候选资源根目录
ipcMain.handle('res:roots', () => resourceRoots())

// 追加用户指定资源目录
ipcMain.handle('res:addRoot', (_e, dir) => {
  if (dir && !userResourceRoots.includes(dir)) userResourceRoots.push(dir)
  return userResourceRoots
})
