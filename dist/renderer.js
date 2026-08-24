// 恶魔连结 存档编辑器 - 渲染进程逻辑
'use strict'

// ================= 编解码（与游戏引擎一致） =================
function decodeSave(text) { return JSON.parse(decodeURIComponent(text)) }
function encodeSave(obj) { return encodeURIComponent(JSON.stringify(obj)) }

// ================= 存档分类 =================
function classifyObj(obj) {
  if (obj && typeof obj === 'object' && 'initialVars' in obj) return 'system'
  if (obj && typeof obj === 'object' && obj.kind === 'save' && Array.isArray(obj.data)) return 'slots'
  if (obj && typeof obj === 'object' && obj.stat && obj.stat.f) return 'single'
  if (typeof obj === 'string' && /^data:image\//.test(obj)) return 'photo'
  return 'unknown'
}
const TYPE_NAME = { system: '系统存档', slots: '槽位存档', single: '快速/自动', photo: '照片', unknown: '其它' }

// ================= 状态 =================
const S = {
  dir: null,
  fileEntries: [],   // {name, size, mtime, full, kind}
  photos: [],        // {id, date, full, thumb}
  system: null,      // {path, obj, orig}
  slots: null,       // {path, obj}
  currentSlotIdx: 0,
  dirty: new Set(),  // 需要写回的文件路径
  activeEntry: null,
}

// ================= DOM 快捷 =================
const $ = id => document.getElementById(id)
function el(tag, cls, html) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}
function fmtSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(2) + ' MB'
}
function fmtDate(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ================= 目录扫描与分组 =================
async function openDir(dir) {
  S.dir = dir
  S.photos = []
  S.system = null
  S.slots = null
  S.dirty.clear()
  S.activeEntry = null
  $('path-label').textContent = dir
  $('path-label').title = dir

  const entries = await window.api.listDir(dir)
  const savs = entries.filter(e => !e.dir && e.name.toLowerCase().endsWith('.sav'))

  // 分类
  const groups = {
    photos: [],
    system: [],
    slots: [],
    single: [],
    other: [],
  }
  const photoMap = new Map()
  for (const e of savs) {
    const n = e.name
    if (n.startsWith('DevilConnection_photo_') && n.endsWith('.sav')) {
      const id = n.slice('DevilConnection_photo_'.length, n.endsWith('_thumb.sav') ? -'_thumb.sav'.length : -'.sav'.length)
      if (n.endsWith('_thumb.sav')) {
        let p = photoMap.get(id) || { id }
        p.thumb = e.full
        photoMap.set(id, p)
      } else if (!n.endsWith('_ids.sav')) {
        let p = photoMap.get(id) || { id }
        p.full = e.full
        photoMap.set(id, p)
      }
      continue
    }
    if (n === 'DevilConnection_sf.sav') { groups.system.push(e); continue }
    if (n === 'DevilConnection_tyrano_data.sav') { groups.slots.push(e); continue }
    if (n.includes('tyrano_quick_save') || n.includes('tyrano_auto_save')) { groups.single.push(e); continue }
    if (n === 'DevilConnection_photo_ids.sav' || n === 'DevilConnection_photo_all_ids.sav') { continue }
    groups.other.push(e)
  }

  // 照片日期来自 photo_ids.sav
  try {
    const idsFile = savs.find(e => e.name === 'DevilConnection_photo_ids.sav')
    if (idsFile) {
      const list = decodeSave(await window.api.readText(idsFile.full))
      if (Array.isArray(list)) {
        for (const it of list) {
          const p = photoMap.get(it.id)
          if (p) p.date = it.date
        }
      }
    }
  } catch (_) {}

  S.photos = [...photoMap.values()].sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  groups.photos = S.photos

  renderFileList(groups)
  renderPhotos()
  setStatus(`${savs.length} 个存档文件，${S.photos.length} 张照片`)
  // 无任何可编辑存档（系统/槽位/快速）时的说明
  const hasEditable = groups.system.length || groups.slots.length || groups.single.length
  if (!hasEditable) {
    const tip = $('empty-hint')
    tip.querySelector('p').textContent = '当前文件夹未找到可编辑的存档（系统/槽位/快速自动存档）。'
    showEmptyHint(true)
    return
  }
  showPanel('photo')
  showEmptyHint(false)
}

function renderFileList(groups) {
  const box = $('file-list')
  box.innerHTML = ''
  const addGroup = (title, icon) => {
    const t = el('div', 'file-group-title')
    t.innerHTML = `${icon} ${title} <span class="badge">0</span>`
    box.appendChild(t)
    return t.querySelector('.badge')
  }
  const addItem = (e, kind, label, thumbDataUrl) => {
    const item = el('div', 'file-item')
    if (thumbDataUrl) {
      const img = el('img', 'fthumb')
      img.src = thumbDataUrl
      item.appendChild(img)
    } else {
      const ic = el('span', 'fthumb', kind === 'system' ? '📊' : kind === 'slots' ? '🗂' : kind === 'single' ? '⚡' : '📄')
      ic.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:16px'
      item.appendChild(ic)
    }
    item.appendChild(el('span', 'fname', label))
    item.appendChild(el('span', 'fsize', fmtSize(e.size)))
    item.addEventListener('click', () => {
      document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'))
      item.classList.add('active')
      openEntry(e, kind)
    })
    return item
  }

  // 照片
  if (groups.photos.length) {
    const b = addGroup('照片', '📷')
    b.textContent = groups.photos.length
    // 占位：照片条目点击进入照片面板
    const item = el('div', 'file-item')
    item.innerHTML = `<span class="fname">全部照片</span><span class="fsize">${groups.photos.length} 张</span>`
    item.addEventListener('click', () => {
      document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'))
      item.classList.add('active')
      renderPhotos()
      showPanel('photo')
    })
    box.appendChild(item)
  }
  for (const kind of ['system', 'slots', 'single']) {
    const arr = groups[kind]
    if (!arr.length) continue
    const b = addGroup(TYPE_NAME[kind], kind === 'system' ? '📊' : kind === 'slots' ? '🗂' : '⚡')
    b.textContent = arr.length
    for (const e of arr) box.appendChild(addItem(e, kind, e.name))
  }
  if (groups.other.length) {
    const b = addGroup('其它文件', '📄')
    b.textContent = groups.other.length
    for (const e of groups.other) addItem(e, 'other', e.name)
  }
}

// ================= 面板切换 =================
function showPanel(name) {
  const map = { photo: 'panel-photo', system: 'panel-system', slots: 'panel-slots' }
  for (const [k, v] of Object.entries(map)) {
    const p = $(v)
    p.style.display = k === name ? 'flex' : 'none'
  }
  $('panels').style.display = 'flex'
  $('empty-hint').style.display = 'none'
  S.activePanel = name
  if (name === 'system') {
    // 面板已显示，校正选择器位置（修复刚打开时消失）；首次定位瞬间落位，不产生位移动画
    const indicator = document.getElementById('tab-indicator')
    if (indicator) indicator.style.transition = 'none'
    moveTabIndicator()
    if (indicator) indicator.style.transition = ''
  }
  updateSaveBtn()
}

function showEmptyHint(v) {
  $('empty-hint').style.display = v ? 'block' : 'none'
  $('panels').style.display = v ? 'none' : 'flex'
}

// ================= 照片预览 =================
function renderPhotos() {
  const grid = $('photo-grid')
  grid.innerHTML = ''
  $('photo-count').textContent = `${S.photos.length} 张`
  S.photos.forEach((p, i) => {
    const card = el('div', 'card')
    card.style.setProperty('--i-delay', Math.min(i * 35, 600) + 'ms') // 有序飞入
    const img = el('img')
    img.alt = p.id
    if (p.thumb) {
      loadThumb(p.thumb).then(d => { if (img.src !== d) img.src = d })
    }
    card.appendChild(img)
    card.appendChild(el('div', 'cap', (p.date || '') + '  ' + p.id))
    card.addEventListener('click', () => openPhotoModal(p))
    grid.appendChild(card)
  })
}

async function loadThumb(path) {
  const text = await window.api.readText(path)
  return decodeSave(text) // 照片/缩略图存档顶层就是 dataURL 字符串
}

function openPhotoModal(p) {
  $('modal-title').textContent = `照片 ${p.id}${p.date ? ' · ' + p.date : ''}`
  const img = $('modal-img')
  img.src = ''
  $('modal').classList.remove('hidden')
  const fullPath = p.full
  $('modal-export').onclick = async () => {
    const dataUrl = await window.api.readText(fullPath).then(t => decodeSave(t))
    await window.api.saveImage(dataUrl, `photo_${p.id}.png`)
  }
  // 优先加载完整图（较大），加载期间先显示缩略图
  if (p.thumb) {
    loadThumb(p.thumb).then(d => { if (!img.src) img.src = d })
  }
  if (fullPath) {
    window.api.readText(fullPath).then(t => {
      img.src = decodeSave(t)
    })
  }
}

// ================= 打开存档文件 =================
async function openEntry(e, kind) {
  try {
    const text = await window.api.readText(e.full)
    const obj = decodeSave(text)
    if (kind === 'system' || classifyObj(obj) === 'system') {
      loadSystem(e.full, obj)
    } else if (kind === 'slots' || classifyObj(obj) === 'slots') {
      loadSlots(e.full, obj)
    } else if (kind === 'single' || classifyObj(obj) === 'single') {
      loadSingle(e.full, obj)
    } else {
      setStatus('无法识别的存档类型: ' + e.name)
      return
    }
    setStatus(`已打开: ${e.name}（${TYPE_NAME[kind] || '其它'}）`)
  } catch (err) {
    setStatus('打开失败: ' + e.name + ' — ' + err.message)
  }
}

// ================= 系统存档 =================
const SYS_LIST_KEYS = ['omakes', 'characters', 'collectedCharacters', 'gallery', 'ngScene']

function loadSystem(path, obj) {
  S.system = { path, obj, orig: deepClone(obj) }
  S.activeEntry = { path, kind: 'system' }
  S.currentPanel = 'system'
  renderSystem()
  showPanel('system')
}

// 概览圆形进度：结局解锁、结局收集、贴纸收集（百分比 + 数量/总数）
function renderOverviewProgress(m) {
  const box = $('overview-progress')
  if (!box) return
  box.innerHTML = ''
  const totalEnd = Object.keys(ENDINGS).length || 0
  const totalStick = Object.keys(STICKERS).length || 0
  const endings = new Set(String(m.endings || []).split(',').filter(Boolean))
  const collected = new Set(String(m.collectedEndings || []).split(',').filter(Boolean))
  const stickers = Array.isArray(m.sticker) ? m.sticker : []
  const mk = (label, cur, total, color) => {
    const pct = total ? Math.round((cur / total) * 100) : 0
    const ring = el('div', 'progress-ring')
    ring.style.background = `conic-gradient(${color} ${pct}%, var(--surface-container-high) 0)`
    const inner = el('div', 'progress-inner')
    inner.appendChild(el('span', 'pct', pct + '%'))
    inner.appendChild(el('span', 'cnt', `${cur}/${total}`))
    ring.appendChild(inner)
    const wrap = el('div', 'progress-item')
    wrap.appendChild(ring)
    wrap.appendChild(el('div', 'progress-label', label))
    return wrap
  }
  box.appendChild(mk('结局解锁', endings.size, totalEnd, 'var(--primary)'))
  box.appendChild(mk('结局收集', collected.size, totalEnd, 'var(--primary)'))
  box.appendChild(mk('贴纸收集', stickers.length, totalStick, 'var(--secondary)'))
}

function renderSystem() {
  const m = S.system.obj
  // 概览字段
  const sfBox = $('sf-fields')
  sfBox.innerHTML = ''
  for (const [key, label, type] of SF_FIELDS) {
    const f = el('div', 'field')
    f.appendChild(el('label', null, label))
    const inp = el('input')
    inp.type = type === 'bool' ? 'checkbox' : 'text'
    inp.dataset.key = key
    inp.dataset.field = 'sf'
    if (type === 'bool') inp.checked = !!m[key]
    else inp.value = m[key] === undefined ? '' : m[key]
    f.appendChild(inp)
    sfBox.appendChild(f)
  }
  // 判定统计
  const jBox = $('judge-fields')
  jBox.innerHTML = ''
  const jc = m.judgeCounts || {}
  for (const key of ['perfect', 'good', 'bad']) {
    const f = el('div', 'field')
    const names = { perfect: '完美判定', good: '良好判定', bad: '失败判定' }
    f.appendChild(el('label', null, names[key]))
    const inp = el('input')
    inp.dataset.key = key
    inp.dataset.field = 'judge'
    inp.value = jc[key] === undefined ? '' : jc[key]
    f.appendChild(inp)
    jBox.appendChild(f)
  }
  // 列表（逗号分隔，长文本自动增高）
  const lBox = $('list-fields')
  lBox.innerHTML = ''
  for (const key of SYS_LIST_KEYS) {
    const f = el('div', 'field')
    f.appendChild(el('label', null, key))
    const ta = document.createElement('textarea')
    ta.dataset.key = key
    ta.dataset.field = 'list'
    ta.dataset.bind = 'grow' // 复用自动增高逻辑
    ta.rows = 1
    ta.className = 'auto-grow'
    ta.spellcheck = false // 关闭拼写检查
    ta.autocomplete = 'off'
    ta.autocapitalize = 'off'
    ta.value = Array.isArray(m[key]) ? m[key].join(', ') : (m[key] || '')
    f.appendChild(ta)
    lBox.appendChild(f)
    bindAutoGrow(ta) // 挂载后再绑定，确保 getComputedStyle 读到真实样式
  }
  // 结局
  const endGrid = $('end-grid')
  endGrid.innerHTML = ''
  for (const [fld] of [['endings'], ['collectedEndings']]) {
    const head = el('div', 'end-grid')
    head.style.gridColumn = '1 / -1'
    head.style.fontWeight = '600'
    head.style.margin = '6px 0 2px'
    head.textContent = fld === 'endings' ? '结局解锁 (endings)' : '结局收集 (collectedEndings)'
    endGrid.appendChild(head)
    const cur = new Set(String(m[fld] || []).split(',').filter(Boolean))
    for (const [id, e] of Object.entries(ENDINGS)) {
      const label = el('label')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = cur.has(id)
      cb.dataset.field = 'end'
      cb.dataset.kind = fld
      cb.dataset.id = id
      label.appendChild(cb)
      label.appendChild(el('span', 'eid', id))
      label.appendChild(el('span', null, e.title))
      label.appendChild(el('span', 'cat', e.cat === 'secret' ? '隐藏' : ''))
      endGrid.appendChild(label)
    }
  }
  // 贴纸（卡片式：缩略图 + 名称 + 勾选）
  const stickGrid = $('stick-grid')
  stickGrid.innerHTML = ''
  const stickers = new Set(m.sticker || [])
  let si = 0
  for (const [sid, name] of Object.entries(STICKERS)) {
    const label = el('label')
    label.title = `${sid}. ${name}`
    label.style.setProperty('--i-delay', Math.min(si * 12, 700) + 'ms') // 有序飞入
    si++
    // 贴纸缩略图预览（从游戏资源 data/image/photo/sticker/<id>.png 提取）
    const img = el('img', 'stick-img')
    img.dataset.sid = sid // 供刷新预览用
    window.api.readResource('data/image/photo/sticker/' + sid + '.png').then(d => {
      if (d) img.src = d
    }).catch(() => {})
    label.appendChild(img)
    const meta = el('div', 'meta')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = stickers.has(Number(sid))
    cb.dataset.field = 'stick'
    cb.dataset.id = sid
    meta.appendChild(cb)
    meta.appendChild(el('span', 'sid', sid))
    meta.appendChild(el('span', 'name', name))
    label.appendChild(meta)
    stickGrid.appendChild(label)
  }
  // 变量表
  renderVarTable($('var-table'), m.initialVars || {}, false)
  // JSON
  $('json-editor').value = JSON.stringify(m, null, 2)
  // 概览圆形进度（结局收集 / 贴纸收集）
  renderOverviewProgress(m)
  // 自动判断全解锁 / 全收集
  const endAll = () => $('end-grid').querySelectorAll('input[data-field="end"]').length > 0
    && [...$('end-grid').querySelectorAll('input[data-field="end"][data-kind="endings"]')].every(cb => cb.checked)
  const collectAll = () => $('end-grid').querySelectorAll('input[data-field="end"][data-kind="collectedEndings"]').length > 0
    && [...$('end-grid').querySelectorAll('input[data-field="end"][data-kind="collectedEndings"]')].every(cb => cb.checked)
  const stickAll = () => $('stick-grid').querySelectorAll('input[data-field="stick"]').length > 0
    && [...$('stick-grid').querySelectorAll('input[data-field="stick"]')].every(cb => cb.checked)
  // 程序设置 checked 不触发 onchange，仅用于如实反映当前是否已全解锁/全收集
  $('end-unlock-all').checked = endAll()
  $('end-collect-all').checked = collectAll()
  $('stick-all').checked = stickAll()
  // 全部解锁/收集快捷
  $('end-unlock-all').onchange = e => {
    $('end-grid').querySelectorAll('input[data-field="end"]').forEach(cb => {
      if (cb.dataset.kind === 'endings') cb.checked = e.target.checked
    })
    renderOverviewProgress(m)
  }
  $('end-collect-all').onchange = e => {
    $('end-grid').querySelectorAll('input[data-field="end"]').forEach(cb => {
      if (cb.dataset.kind === 'collectedEndings') cb.checked = e.target.checked
    })
    renderOverviewProgress(m)
  }
  $('stick-all').onchange = e => {
    $('stick-grid').querySelectorAll('input[data-field="stick"]').forEach(cb => { cb.checked = e.target.checked })
    renderOverviewProgress(m)
  }
  initTabButtons()
  updateSaveBtn()
  updateNameHint()
}

// 召唤师名字提示：实际名字存储在槽位存档 stat.f.name，系统存档 initialVars.name 为初始默认值
async function updateNameHint() {
  const hint = $('name-hint')
  if (!hint) return
  if (S.slots && S.slots.obj) {
    hint.innerHTML = nameHintHtml(collectSlotNames(S.slots.obj))
    return
  }
  hint.innerHTML = '正在读取槽位存档，提取召唤师名字…'
  try {
    if (!S.dir) return
    const entries = await window.api.listDir(S.dir)
    const td = entries.find(e => e.name === 'DevilConnection_tyrano_data.sav')
    if (td) {
      const obj = decodeSave(await window.api.readText(td.full))
      S.slots = { path: td.full, obj } // 缓存，避免后续重复解码
      hint.innerHTML = nameHintHtml(collectSlotNames(obj))
    } else {
      hint.innerHTML = '未找到槽位存档（tyrano_data.sav）。召唤师名字存储在<b>槽位存档</b>的 stat.f.name 中。'
    }
  } catch (_) {
    hint.innerHTML = '读取槽位存档失败。召唤师名字存储在<b>槽位存档</b>的 stat.f.name 中。'
  }
}

function collectSlotNames(slotsObj) {
  const names = []
  const seen = new Set()
  for (const s of (slotsObj.data || [])) {
    const n = s.stat && s.stat.f && s.stat.f.name
    if (n && !seen.has(n)) { seen.add(n); names.push(n) }
  }
  return names
}

function nameHintHtml(names) {
  const main = names[0] || '（未找到）'
  const all = names.length > 1 ? `（另有 ${names.slice(1).map(esc).join('、')}）` : ''
  return `当前召唤师名字（来自槽位存档）: <b>${esc(main)}</b> ${all}<br>` +
    `游戏机制：系统存档 initialVars.name 始终为初始默认值，实际名字存储在<b>槽位存档</b>的 stat.f.name，请到「槽位存档」标签中修改。`
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// 变量表渲染
function renderVarTable(container, data, compact, descMap) {
  // 槽位 stat.f 变量表：用专用说明字典，说明放悬停 title，不含全局分组
  if (compact && descMap) {
    renderCompactSlots(container, data, descMap)
    return
  }
  container.innerHTML = ''
  const addHead = () => {
    if (compact) {
      container.appendChild(el('div', 'vt-head', '变量名'))
      container.appendChild(el('div', 'vt-head', '值'))
    } else {
      container.appendChild(el('div', 'vt-head', '变量名'))
      container.appendChild(el('div', 'vt-head', '说明'))
      container.appendChild(el('div', 'vt-head', '值'))
    }
  }
  addHead()
  let ri = 0
  for (const g of VAR_GROUPS) {
    container.appendChild(el('div', 'vt-group', '—— ' + g + ' ——'))
    for (const [name, [desc, grp, type]] of Object.entries(VAR_INFO)) {
      if (grp !== g) continue
      const nEl = el('div', 'vt-name', name)
      nEl.dataset.r = ri
      container.appendChild(nEl)
      if (!compact) { const dEl = el('div', 'vt-desc', desc); dEl.dataset.r = ri; container.appendChild(dEl) }
      const cell = el('div', 'vt-val')
      cell.dataset.r = ri
      const inp = el('input')
      inp.dataset.var = name
      inp.dataset.vtype = type
      inp.value = fmtVarVal(data[name], type)
      cell.appendChild(inp)
      container.appendChild(cell)
      ri++
    }
  }
  // 数据中存在但字典未收录的变量
  const extra = Object.keys(data).filter(k => !(k in VAR_INFO) && k !== '_tap_effect')
  if (extra.length) {
    container.appendChild(el('div', 'vt-group', '—— 其它（字典未收录） ——'))
    for (const k of extra) {
      const nEl = el('div', 'vt-name', k)
      nEl.dataset.r = ri
      container.appendChild(nEl)
      if (!compact) { const dEl = el('div', 'vt-desc', ''); dEl.dataset.r = ri; container.appendChild(dEl) }
      const cell = el('div', 'vt-val')
      cell.dataset.r = ri
      const inp = el('input')
      inp.dataset.var = k
      inp.dataset.vtype = typeof data[k] === 'number' ? 'int' : typeof data[k] === 'boolean' ? 'bool' : (Array.isArray(data[k]) ? 'array' : 'str')
      inp.value = fmtVarVal(data[k], inp.dataset.vtype)
      cell.appendChild(inp)
      container.appendChild(cell)
      ri++
    }
  }
}
function fmtVarVal(v, type) {
  if (v === undefined || v === null) return ''
  if (type === 'array') return Array.isArray(v) ? v.join(', ') : String(v)
  return String(v)
}

// 槽位 stat.f 变量表（变量名 / 说明 / 值，与系统存档变量表一致）
function renderCompactSlots(container, data, descMap) {
  container.innerHTML = ''
  container.appendChild(el('div', 'vt-head', '变量名'))
  container.appendChild(el('div', 'vt-head', '说明'))
  container.appendChild(el('div', 'vt-head', '值'))
  const keys = Object.keys(data || {}).sort()
  keys.forEach((k, i) => {
    const nEl = el('div', 'vt-name', k)
    nEl.dataset.r = i
    container.appendChild(nEl)
    const dEl = el('div', 'vt-desc', descMap[k] || '游戏运行时变量 f.' + k + '（含义未收录，请谨慎修改）')
    dEl.dataset.r = i
    container.appendChild(dEl)
    const cell = el('div', 'vt-val')
    cell.dataset.r = i
    const inp = el('input')
    inp.dataset.var = k
    inp.dataset.vtype =
      typeof data[k] === 'number' ? 'int' : typeof data[k] === 'boolean' ? 'bool' : Array.isArray(data[k]) ? 'array' : 'str'
    inp.value = fmtVarVal(data[k], inp.dataset.vtype)
    cell.appendChild(inp)
    container.appendChild(cell)
  })
}

// 按 名称/说明/值 过滤变量表（隐藏不匹配行）；继续未匹配行号分组的可见性
function filterVarRows(container, query) {
  query = (query || '').trim().toLowerCase()
  const rows = new Map()
  container.querySelectorAll('[data-r]').forEach(el => {
    const r = el.dataset.r
    if (!rows.has(r)) rows.set(r, { els: [], matched: false })
    const row = rows.get(r)
    row.els.push(el)
    if ((el.textContent || '').toLowerCase().includes(query)) row.matched = true
  })
  rows.forEach(row => {
    const hide = !row.matched
    row.els.forEach(e => { e.style.display = hide ? 'none' : '' })
  })
}

// 选择器定位：必须等面板显示（offsetLeft/offsetWidth 可用）后再调用，否则会定位到 0 而消失
function moveTabIndicator() {
  const container = document.querySelector('#panel-system .tabs')
  const indicator = document.getElementById('tab-indicator')
  const active = container && container.querySelector('.tab.active')
  if (!container || !indicator || !active) return
  indicator.style.left = active.offsetLeft + 'px'
  indicator.style.width = active.offsetWidth + 'px'
}
let tabResizeBound = false // 窗口 resize 监听只绑定一次，避免重复渲染累积

function initTabButtons() {
  const container = document.querySelector('#panel-system .tabs')
  const tabs = document.querySelectorAll('#panel-system .tab')
  // 滑动 pill 指示器（选择器）
  let indicator = document.getElementById('tab-indicator')
  if (!indicator && container) {
    indicator = el('div', 'tab-indicator')
    indicator.id = 'tab-indicator'
    container.appendChild(indicator)
  }
  const moveTo = t => {
    if (!indicator || !t) return
    indicator.style.left = t.offsetLeft + 'px'
    indicator.style.width = t.offsetWidth + 'px'
  }
  tabs.forEach(t => {
    t.onclick = () => {
      if (indicator) indicator.style.transition = '' // 确保点击切换有平滑动画（清除拖动残留的 none）
      tabs.forEach(x => x.classList.remove('active'))
      t.classList.add('active')
      document.querySelectorAll('#panel-system .tabpage').forEach(p => p.classList.remove('active'))
      const target = $('sys-' + t.dataset.tab)
      target.classList.add('active')
      // 内容切换动画（平滑淡入上移）
      target.classList.remove('anim-in')
      void target.offsetWidth
      target.classList.add('anim-in')
      moveTabIndicator()
    }
  })
  moveTabIndicator() // 初始定位；若面板尚未显示（display:none）由 showPanel 显示后再次校正
  // 窗口尺寸变化时校正指示器
  if (!tabResizeBound) {
    tabResizeBound = true
    window.addEventListener('resize', moveTabIndicator)
  }

  // 选择器拖动：磁吸式（平滑滑向最近选项卡），松手吸附并切换
  // 用 Pointer Events + setPointerCapture：指针移出窗口也能收到 pointerup，
  // 避免拖动状态/过渡残留导致"偶尔没有动画"或选择器乱飘
  const findTabAt = clientX => {
    let hit = null
    for (const t of tabs) {
      const r = t.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right) { hit = t; break }
    }
    if (hit) return hit
    // 不在任何 tab 上时取最近
    let best = null, bestD = Infinity
    for (const t of tabs) {
      const r = t.getBoundingClientRect()
      const c = (r.left + r.right) / 2
      const d = Math.abs(clientX - c)
      if (d < bestD) { bestD = d; best = t }
    }
    return best
  }
  let activePointer = null
  let dragMoved = false
  container.addEventListener('pointerdown', e => {
    activePointer = e.pointerId
    dragMoved = false
    try { container.setPointerCapture(e.pointerId) } catch (_) {}
  })
  container.addEventListener('pointermove', e => {
    if (activePointer !== e.pointerId) return
    const t = findTabAt(e.clientX)
    if (t) {
      if (!dragMoved && indicator) indicator.style.transition = 'left .14s ease, width .14s ease' // 磁吸滑动（比点击略快）
      moveTo(t)
      dragMoved = true
    }
  })
  container.addEventListener('pointerup', e => {
    if (activePointer !== e.pointerId) return
    activePointer = null
    if (indicator) indicator.style.transition = ''
    // 无论是否拖动都自行吸附/切换到最近选项卡。
    // 注意：setPointerCapture 会把原生 click 的目标改成容器，tab.onclick 不再触发，故此处统一处理
    const t = findTabAt(e.clientX)
    if (t && !t.classList.contains('active')) t.click()
    else moveTabIndicator() // 已在当前，回正
  })
  container.addEventListener('pointercancel', e => {
    if (activePointer !== e.pointerId) return
    activePointer = null
    if (indicator) indicator.style.transition = ''
    moveTabIndicator() // 拖动被取消，回正
  })
}

// ================= 槽位存档 =================
const SLOT_HINT =
  '<b>槽位存档</b>（DevilConnection_tyrano_data.sav）包含游戏内手动存档的全部槽位（数量动态增长，最多 600）。' +
  '左侧选择槽位，右侧编辑元信息与 <b>stat.f</b> 变量表；' +
  '召唤师名字实际存储在 <b>stat.f.name</b>，需在此处修改（系统存档 initialVars.name 为初始默认值）。' +
  '修改后点击顶部「保存」写回原文件。'

// 槽位元信息字段：[key, 标签, 悬停说明]
const SLOT_META_DEF = [
  ['title', '标题', '槽位显示标题'],
  ['save_date', '保存时间', '该槽位的存档时间'],
  ['current_order_index', '脚本索引', '当前剧情脚本位置索引'],
  ['subtitle', '副标题ID', '副标题对应的脚本/文本 ID'],
  ['subtitleText', '副标题文本', '副标题显示文字'],
  ['phase_file', '阶段图', '背景/阶段图资源路径，用于缩略图预览'],
]

// 槽位存档 stat.f 变量说明（悬停在变量名上显示）。未收录的变量为游戏运行时标记，通用提示。
const SLOT_VAR_DESC = {
  name: '召唤师名字（昵称），修改后游戏内生效',
  seibetu: '性别（1 男 / 2 女）',
  day: '当前天数',
  day_epilogue: '尾声（战后）天数',
  script: '当前剧情脚本进度',
  phrase: '当前台词',
  chara: '当前操控/跟随角色',
  charaFile: '当前角色立绘文件（data/image/<file>）',
  currentCharacters: '当前同行角色数组',
  characters: '已收集角色数组',
  memberCount: '队伍（同行）人数',
  mp: '当前魔力',
  mp_max: '魔力上限',
  totalMP: '累计获得的魔力',
  kill: '狂信徒线标记（>0 进入狂信徒路线）',
  autoSave: '自动存档标记',
  judge: '上一判定（perfect / good / bad）',
  currentLoop: '当前周目数',
  previousEnding: '上一个触发的结局 ID',
  ransuu: '随机数（部分演出用）',
  debiName: '魔王名字',
  hint: '提示信息标记',
  hintIdx: '提示索引',
  syo: '召唤相关标记',
  goal: '终点/目标标记',
  koukai_kidoku: '告白场景已读',
  coronation: '加冕相关标记',
  lapis: '拉皮斯（宝石道具）数量',
  lapis_clear: '拉皮斯线通关标记',
  lapis_watasu: '拉皮斯相关交付标记',
  jewelry: '宝石类道具标记',
  yubiwa: '戒指道具标记',
  crown: '皇冠道具标记',
  tuno: '角道具标记',
  ruby: '红宝石道具标记',
  sign: '表/印记道具标记',
  ting: '记录铃铛道具标记',
  ne: '猫妖“ね”相关标记',
  kupya_tap: '库啪点击次数',
  kupya_inori: '库啪祈祷标记',
  kupya_meteor: '库啪流星事件标记',
  zyagan_count: '智眼累计次数',
  zyagan1_search: '智眼·第1次搜索标记',
  zyagan2_search: '智眼·第2次搜索标记',
  zyagan3_search: '智眼·第3次搜索标记',
}

// 槽位存档提示条：可关闭，关闭后记住不再显示（localStorage）
function renderSlotHint() {
  const hint = $('slot-hint')
  if (!hint) return
  let closed = false
  try { closed = localStorage.getItem('dc-slot-hint-closed') === '1' } catch (_) {}
  if (closed) { hint.style.display = 'none'; return }
  hint.style.display = ''
  hint.innerHTML = SLOT_HINT
  const closeBtn = el('span', 'slot-hint-close', '✕')
  closeBtn.title = '不再显示此提示'
  closeBtn.onclick = () => {
    hint.style.display = 'none'
    try { localStorage.setItem('dc-slot-hint-closed', '1') } catch (_) {}
  }
  hint.appendChild(closeBtn)
}

function loadSlots(path, obj) {
  S.slots = { path, obj }
  S.activeEntry = { path, kind: 'slots' }
  S.currentPanel = 'slots'
  renderSlotHint()
  renderSlotGrid()
  if (obj.data && obj.data.length) selectSlot(0)
  showPanel('slots')
}

function renderSlotGrid() {
  const grid = $('slot-grid')
  grid.innerHTML = ''
  const data = S.slots.obj.data || []
  data.forEach((slot, i) => {
    const card = el('div', 'slot-card')
    card.dataset.idx = i
    card.style.setProperty('--i-delay', Math.min(i * 25, 500) + 'ms') // 有序飞入
    const img = el('img')
    setSlotThumb(img, slot)
    card.appendChild(img)
    const info = el('div', 'info')
    info.appendChild(el('div', 't', slot.title || '未保存'))
    info.appendChild(el('div', 'd', slot.save_date || ''))
    if (slot.subtitleText) info.appendChild(el('div', 'd', slot.subtitleText))
    card.appendChild(info)
    card.addEventListener('click', () => selectSlot(i))
    grid.appendChild(card)
  })
}

// 槽位缩略图：优先存档内截图 img_data，否则尝试提取游戏资源 phase_file 作为预览
async function setSlotThumb(img, slot) {
  if (slot.img_data) { img.src = slot.img_data; return }
  if (slot.phase_file) {
    try {
      const d = await window.api.readResource(slot.phase_file)
      if (d) img.src = d
    } catch (_) {}
  }
}

function selectSlot(idx) {
  const data = S.slots.obj.data
  if (!data || idx >= data.length) return
  S.currentSlotIdx = idx
  document.querySelectorAll('.slot-card').forEach(c => c.classList.toggle('active', Number(c.dataset.idx) === idx))
  const slot = data[idx]
  const metaBox = $('slot-meta')
  metaBox.innerHTML = ''
  const metaDef = SLOT_META_DEF
  for (const [key, label, desc] of metaDef) {
    const f = el('div', 'field')
    const lab = el('label', null, label)
    if (desc) lab.title = desc
    f.appendChild(lab)
    const inp = el('input')
    inp.dataset.meta = key
    inp.value = slot[key] === undefined ? '' : slot[key]
    f.appendChild(inp)
    metaBox.appendChild(f)
  }
  const f = slot.stat && slot.stat.f ? slot.stat.f : {}
  renderVarTable($('slot-vars'), f, true, SLOT_VAR_DESC)
}

// ================= 快速/自动存档（单存档） =================
function loadSingle(path, obj) {
  S.slots = { path, obj, single: true }
  S.activeEntry = { path, kind: 'single' }
  renderSlotHint()
  // 复用槽位视图
  const grid = $('slot-grid')
  grid.innerHTML = ''
  const card = el('div', 'slot-card')
  card.classList.add('active')
  const img = el('img')
  if (obj.img_data) img.src = obj.img_data
  card.appendChild(img)
  const info = el('div', 'info')
  info.appendChild(el('div', 't', obj.title || '存档'))
  info.appendChild(el('div', 'd', obj.save_date || ''))
  card.appendChild(info)
  grid.appendChild(card)
  const metaBox = $('slot-meta')
  metaBox.innerHTML = ''
  const metaDef = SLOT_META_DEF
  for (const [key, label, desc] of metaDef) {
    const f = el('div', 'field')
    const lab = el('label', null, label)
    if (desc) lab.title = desc
    f.appendChild(lab)
    const inp = el('input')
    inp.dataset.meta = key
    inp.value = obj[key] === undefined ? '' : obj[key]
    f.appendChild(inp)
    metaBox.appendChild(f)
  }
  const f = obj.stat && obj.stat.f ? obj.stat.f : {}
  renderVarTable($('slot-vars'), f, true, SLOT_VAR_DESC)
  showPanel('slots')
}

// ================= 收集与保存 =================
function collectSystem() {
  const m = S.system.obj
  const orig = S.system.orig
  // sf 字段
  document.querySelectorAll('#sf-fields input').forEach(inp => {
    const key = inp.dataset.key
    if (inp.type === 'checkbox') {
      if (inp.checked !== !!orig[key]) m[key] = inp.checked
    } else {
      if (inp.value !== String(orig[key] === undefined ? '' : orig[key])) m[key] = toScalar(inp.value)
    }
  })
  // 判定
  document.querySelectorAll('#judge-fields input').forEach(inp => {
    const key = inp.dataset.key
    const ov = orig.judgeCounts && orig.judgeCounts[key]
    if (inp.value !== String(ov === undefined ? '' : ov)) {
      m.judgeCounts = m.judgeCounts || {}
      m.judgeCounts[key] = toScalar(inp.value)
    }
  })
  // 列表
  document.querySelectorAll('#list-fields input, #list-fields textarea').forEach(inp => {
    const key = inp.dataset.key
    const ov = Array.isArray(orig[key]) ? orig[key].join(', ') : (orig[key] || '')
    if (inp.value !== ov) {
      m[key] = inp.value.split(',').map(s => s.trim()).filter(Boolean).map(toScalar)
    }
  })
  // 结局（字符串集合）
  for (const fld of ['endings', 'collectedEndings']) {
    m[fld] = m[fld] || []
    const cur = new Set(m[fld].map(String))
    document.querySelectorAll(`input[data-field="end"][data-kind="${fld}"]`).forEach(cb => {
      const id = cb.dataset.id
      if (cb.checked) cur.add(id)
      else cur.delete(id)
    })
    m[fld] = [...cur].sort((a, b) => Number(a) - Number(b))
  }
  // 贴纸（整数集合）
  const stickers = new Set(m.sticker || [])
  document.querySelectorAll('input[data-field="stick"]').forEach(cb => {
    const id = Number(cb.dataset.id)
    if (cb.checked) stickers.add(id)
    else stickers.delete(id)
  })
  m.sticker = [...stickers].sort((a, b) => a - b)
  // 变量（仅写回修改）
  const init = m.initialVars = m.initialVars || {}
  document.querySelectorAll('#var-table input').forEach(inp => {
    const name = inp.dataset.var
    const type = inp.dataset.vtype
    const ov = fmtVarVal(orig.initialVars && orig.initialVars[name], type)
    if (inp.value !== ov) init[name] = parseVal(inp.value, type)
  })
}

function collectSlots() {
  const m = S.slots.obj
  if (S.slots.single) {
    collectSingleSlot(m)
    return
  }
  const data = m.data || []
  const slot = data[S.currentSlotIdx]
  if (!slot) return
  collectSingleSlot(slot)
}

function collectSingleSlot(slot) {
  document.querySelectorAll('#slot-meta input').forEach(inp => {
    const key = inp.dataset.meta
    if (key === 'current_order_index') slot[key] = toScalar(inp.value)
    else slot[key] = inp.value
  })
  const f = slot.stat = slot.stat || {}
  f.f = f.f || {}
  document.querySelectorAll('#slot-vars input').forEach(inp => {
    f.f[inp.dataset.var] = parseVal(inp.value, inp.dataset.vtype)
  })
}

function saveAll() {
  showToast('保存中…', 'busy')
  try {
    if (S.currentPanel === 'system' && S.system) {
      collectSystem()
      const text = encodeSave(S.system.obj)
      window.api.writeText(S.system.path, text)
      S.system.orig = deepClone(S.system.obj)
      $('json-editor').value = JSON.stringify(S.system.obj, null, 2)
      setStatus('已保存: ' + S.system.path)
    } else if (S.currentPanel === 'slots' && S.slots) {
      collectSlots()
      const text = encodeSave(S.slots.obj)
      window.api.writeText(S.slots.path, text)
      renderSlotGrid()
      setStatus('已保存: ' + S.slots.path)
    }
    showToast('保存成功', 'success')
  } catch (err) {
    setStatus('保存失败: ' + err.message)
    showToast('保存失败: ' + err.message, 'error')
  }
}

// 轻量 toast 提示：成功/主题色=success，保存中=busy，失败=error
let toastTimer = null
function showToast(msg, type) {
  const t = $('toast')
  if (!t) return
  t.textContent = msg
  t.className = 'toast ' + (type || 'success')
  if (toastTimer) clearTimeout(toastTimer)
  if (type === 'busy') return // 保存中持续显示
  toastTimer = setTimeout(() => { t.className = 'toast hidden' }, 2200)
}

// 文本域自动增高：展开最多 4 行（超出滚动），收起回单行；带 height 过渡动画
function bindAutoGrow(ta) {
  const cs = getComputedStyle(ta)
  const fs = parseFloat(cs.fontSize) || 13
  const rawLh = parseFloat(cs.lineHeight)
  const lh = rawLh || fs * 1.4
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
  const oneLine = Math.round(lh + pad) // 单行
  const fourLine = Math.round(lh * 4 + pad) // 4 行
  const curH = () => ta.getBoundingClientRect().height
  const grow = () => {
    const from = curH()
    ta.style.overflow = 'auto' // 超过 4 行后出现滚动条
    ta.style.height = 'auto'
    const target = Math.min(ta.scrollHeight, fourLine)
    ta.style.height = from + 'px' // 固定当前作为过渡起点
    void ta.offsetHeight
    ta.style.height = target + 'px' // 触发 height 过渡
  }
  const collapse = () => {
    const from = curH()
    ta.style.height = from + 'px'
    void ta.offsetHeight
    ta.style.height = oneLine + 'px' // 收起回单行
    ta.style.overflow = 'hidden' // 收回后单行截断，不显示滚动条
  }
  ta.addEventListener('focus', grow)
  ta.addEventListener('input', grow)
  ta.addEventListener('blur', collapse)
}

// ================= 工具函数 =================
function toScalar(s) {
  s = String(s).trim()
  if (s === '') return s
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (!isNaN(Number(s))) return Number(s)
  return s
}
function parseVal(raw, type) {
  if (type === 'array') return raw.split(',').map(s => s.trim()).filter(Boolean).map(toScalar)
  if (type === 'bool') return /^(1|true|yes|on|是)$/i.test(raw.trim())
  return toScalar(raw)
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)) }
function setStatus(t) { $('statusbar').textContent = t }
function updateSaveBtn() { $('btn-save').disabled = !(S.currentPanel === 'system' || S.currentPanel === 'slots') }

// ================= 事件绑定 =================
$('btn-open').onclick = async () => {
  const dir = await window.api.pickDir()
  if (dir) await openDir(dir)
}
$('btn-refresh').onclick = async () => { if (S.dir) await openDir(S.dir) }
$('btn-save').onclick = saveAll

// 备份：把存档目录复制到 backup/<时间戳>
$('btn-backup').onclick = async () => {
  if (!S.dir) { showToast('请先打开存档文件夹', 'error'); return }
  const dest = await window.api.backup(S.dir)
  if (dest) { showToast('已备份到 backup/' + pathBase(dest), 'success'); setStatus('已备份: ' + dest) }
  else showToast('备份失败', 'error')
}
// 还原：列出 backup/ 供选择
$('btn-restore').onclick = async () => {
  if (!S.dir) { showToast('请先打开存档文件夹', 'error'); return }
  const list = await window.api.listBackups(S.dir)
  const box = $('restore-list')
  box.innerHTML = ''
  if (!list.length) { box.textContent = 'backup/ 下暂无备份。'; $('restore-modal').classList.remove('hidden'); return }
  const fmtBackup = n => { const t = +n; if (!t || isNaN(t)) return n; const d = new Date(t * 1000); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
  for (const name of list) {
    const row = el('div', 'file-item')
    row.innerHTML = `<span class="fname">${fmtBackup(name)}</span><span class="fsize">${name}</span>`
    row.addEventListener('click', async () => {
      if (!confirm('确定用该备份覆盖当前存档文件夹？建议先再备份一次。')) return
      const ok = await window.api.restore(S.dir, name)
      if (ok) {
        $('restore-modal').classList.add('hidden')
        showToast('已还原', 'success')
        await openDir(S.dir)
      } else showToast('还原失败', 'error')
    })
    box.appendChild(row)
  }
  $('restore-modal').classList.remove('hidden')
}
$('restore-close').onclick = () => $('restore-modal').classList.add('hidden')

// ---------- 检查更新（GitHub Releases） ----------
const APP_VERSION = '0.1.1'
const UPDATE_REPO = 'moruacat/DC-SavaEditor'
function versionCmp(a, b) {
  // a > b 返回 1，a < b 返回 -1，相等 0
  const pa = String(a).replace(/^[vV]/,'').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^[vV]/,'').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}
$('btn-update').onclick = async () => {
  const btn = $('btn-update')
  btn.textContent = '⌛ 检查中…'
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const latest = data.tag_name || ''
    const online = String(latest).replace(/^v/i, '')
    const cur = APP_VERSION
    if (!online) { showToast('远程无版本信息', 'error') }
    else if (versionCmp(online, cur) > 0) {
      showToast(`发现新版本 ${latest}（当前 ${APP_VERSION}），请前往 GitHub Releases 下载`, 'success')
      if (data.html_url) setStatus('新版本: ' + latest + '  ' + data.html_url)
    } else {
      showToast(`已是最新版本 ${cur}`, '')
      setStatus('已是最新版本')
    }
  } catch (e) {
    showToast('检查更新失败（网络/网络受限）', 'error')
    setStatus('检查更新失败: ' + e.message)
  } finally {
    btn.textContent = '🔁 检查更新'
  }
}

// 导出系统存档（解码为明文 JSON）
$('btn-export').onclick = async () => {
  if (!S.system) { showToast('请先打开系统存档', 'error'); return }
  try {
    collectSystem()
    const content = JSON.stringify(S.system.obj, null, 2)
    const ok = await window.api.saveText(content, (S.system.appName || 'DevilConnection_sf') + '.json')
    if (ok) showToast('已导出明文 JSON', 'success')
  } catch (e) { showToast('导出失败: ' + e.message, 'error') }
}
// 导入明文 JSON 并载入系统存档
$('btn-import').onclick = async () => {
  const res = await window.api.openText()
  if (!res) return
  try {
    const obj = JSON.parse(res.text)
    if (!(obj && typeof obj === 'object' && 'initialVars' in obj)) { showToast('不是系统存档结构', 'error'); return }
    if (!S.system) { S.system = { path: S.dir + '/DevilConnection_sf.sav', obj, orig: deepClone(obj) } }
    else { S.system.obj = obj; S.system.orig = deepClone(obj) }
    S.currentPanel = 'system'
    renderSystem()
    showPanel('system')
    setStatus('已导入并载入系统存档: ' + res.name)
    showToast('已导入', 'success')
  } catch (e) { showToast('导入解析失败: ' + e.message, 'error') }
}

function pathBase(p) {
  p = String(p).replace(/\\/g, '/')
  return p.split('/').filter(Boolean).pop() || p
}
// 刷新已渲染的贴纸缩略图（用于重新指定资源目录后）
function refreshStickerThumbs() {
  document.querySelectorAll('#stick-grid img').forEach(img => {
    const sid = img.dataset.sid
    if (sid == null) return
    window.api.readResource('data/image/photo/sticker/' + sid + '.png').then(d => {
      if (d) img.src = d
    }).catch(() => {})
  })
}
$('btn-resource').onclick = async () => {
  const dir = await window.api.pickDir()
  if (dir) {
    $('res-label').textContent = dir
    $('res-label').title = dir
    await window.api.addResourceRoot(dir) // 告知后端，读取资源时优先查该目录
    refreshStickerThumbs()
    setStatus('资源目录已设置，贴纸预览已刷新')
  }
}

// 批量导出全部照片到所选目录
$('btn-batch-export').onclick = async () => {
  if (!S.photos.length) { showToast('没有可导出的照片', 'error'); return }
  const dir = await window.api.pickDir()
  if (!dir) return
  showToast(`导出中（0/${S.photos.length}）…`, 'busy')
  let ok = 0, fail = 0
  for (let i = 0; i < S.photos.length; i++) {
    const p = S.photos[i]
    try {
      const path = p.full || p.thumb
      if (!path) { fail++; continue }
      const dataUrl = decodeSave(await window.api.readText(path))
      const dest = dir + '/' + sanitizeFileName('photo_' + p.id) + '.png'
      const r = await window.api.saveDataUrl(dest, dataUrl)
      if (r) ok++; else fail++
    } catch (_) { fail++ }
    if ((i + 1) % 5 === 0 || i === S.photos.length - 1) showToast(`导出中（${i + 1}/${S.photos.length}）…`, 'busy')
  }
  showToast(fail ? `完成：成功 ${ok}，失败 ${fail}` : `成功导出 ${ok} 张`, fail ? 'error' : 'success')
  setStatus(`批量导出完成：成功 ${ok} 张，失败 ${fail} 张 → ${dir}`)
}
function sanitizeFileName(n) { return String(n).replace(/[\\/:*?"<>|]/g, '_') }
$('modal-close').onclick = () => $('modal').classList.add('hidden')
$('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').classList.add('hidden') })
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').classList.add('hidden') })

// ---------- 多语言（lang_*.json，检测到才显示语言选择） ----------
const I18N_CODES = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh-Hant', name: '繁體中文' },
]
let i18nMap = null // 当前翻译 { 原中文: 译文 }
function applyI18n() {
  if (!i18nMap) return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const n = walker.currentNode
    const v = n.nodeValue
    if (v && i18nMap[v]) n.nodeValue = i18nMap[v]
  }
  document.querySelectorAll('input[placeholder]').forEach(el => {
    const p = el.getAttribute('placeholder')
    if (p && i18nMap[p]) el.setAttribute('placeholder', i18nMap[p])
  })
}
async function initI18n() {
  const sel = $('lang-sel')
  // 探测可用的翻译文件
  const found = []
  for (const l of I18N_CODES) {
    try {
      const r = await fetch(`lang_${l.code}.json`)
      if (r.ok) { found.push({ ...l, map: await r.json() }) }
    } catch (_) {}
  }
  // 检测到任何翻译文件才显示语言选择
  if (!found.length) { sel.style.display = 'none'; return }
  sel.style.display = ''
  sel.innerHTML = '<option value="zh">中文</option>' + found.map(l => `<option value="${l.code}">${l.name}</option>`).join('')
  let saved = null
  try { saved = localStorage.getItem('dc-lang') } catch (_) {}
  if (saved) { sel.value = saved; const hit = found.find(l => l.code === saved); if (hit) { i18nMap = hit.map; applyI18n() } }
  sel.addEventListener('change', () => {
    const code = sel.value
    if (code === 'zh') { i18nMap = null }
    else { const hit = found.find(l => l.code === code); if (hit) i18nMap = hit.map }
    try { localStorage.setItem('dc-lang', code) } catch (_) {}
    applyI18n()
    showToast(i18nMap ? '界面已切换语言' : '界面已恢复中文', 'success')
  })
}

// ---------- 字段搜索 ----------
$('var-search').addEventListener('input', e => filterVarRows($('var-table'), e.target.value))
$('slot-var-search').addEventListener('input', e => filterVarRows($('slot-vars'), e.target.value))
$('slot-search').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase()
  document.querySelectorAll('.slot-card').forEach(c => {
    c.style.display = (!q || (c.textContent || '').toLowerCase().includes(q)) ? '' : 'none'
  })
})
// JSON 查找：Enter 跳到下一个匹配
let jsonSearchIdx = 0
$('json-search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  const ed = $('json-editor')
  const q = $('json-search').value
  if (!q) { setStatus(''); return }
  const val = ed.value.toLowerCase()
  const needle = q.toLowerCase()
  let idx = val.indexOf(needle, jsonSearchIdx)
  if (idx === -1) idx = val.indexOf(needle) // 回绕
  if (idx === -1) { setStatus('JSON 中未找到: ' + q); jsonSearchIdx = 0; return }
  jsonSearchIdx = idx + needle.length
  ed.focus()
  ed.setSelectionRange(idx, idx + needle.length)
  const line = val.slice(0, idx).split('\n').length
  ed.scrollTop = Math.max(0, (line - 4) * 18)
  setStatus(`JSON 匹配（第 ${line} 行）`)
})
// 过滤 JSON 匹配：未匹配行禁用编辑态（仅提示）
$('json-search').addEventListener('input', () => { jsonSearchIdx = 0 })

// ---------- JSON 编辑器自动变大（编辑时增高，失焦收起） ----------
const jsonEd = $('json-editor')
jsonEd.addEventListener('focus', () => jsonEd.classList.add('growing'))
jsonEd.addEventListener('input', () => {
  jsonEd.style.height = 'auto'
  jsonEd.style.height = Math.min(jsonEd.scrollHeight, 520) + 'px'
})
jsonEd.addEventListener('blur', () => {
  jsonEd.classList.remove('growing')
  jsonEd.style.height = ''
})

// JSON 应用按钮
{
  const bar = el('div')
  bar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px'
  const applyBtn = el('button', 'btn', '应用 JSON 到界面')
  applyBtn.onclick = () => {
    try {
      const obj = JSON.parse($('json-editor').value)
      if (classifyObj(obj) !== 'system') { setStatus('JSON 不是系统存档结构'); return }
      S.system.obj = obj
      S.system.orig = deepClone(obj)
      renderSystem()
      setStatus('已应用 JSON')
    } catch (e) { setStatus('JSON 解析失败: ' + e.message) }
  }
  bar.appendChild(applyBtn)
  $('sys-json').prepend(bar)
}

// ================= 主题（深色/浅色） =================
function initTheme() {
  let saved = null
  try { saved = localStorage.getItem('dc-theme') } catch (_) {}
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme(saved || (prefersDark ? 'dark' : 'light'))
  $('btn-theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try { localStorage.setItem('dc-theme', next) } catch (_) {}
  }
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t
  $('btn-theme').textContent = t === 'dark' ? '☀️ 浅色' : '🌙 深色'
}

// ================= 动画开关（回弹/弹跳/平滑过渡） =================
function initAnim() {
  let enabled = true
  try { enabled = localStorage.getItem('dc-anim') !== 'off' } catch (_) {}
  applyAnim(enabled)
  $('btn-anim').onclick = () => {
    enabled = !enabled
    applyAnim(enabled)
    try { localStorage.setItem('dc-anim', enabled ? 'on' : 'off') } catch (_) {}
  }
}
function applyAnim(en) {
  document.documentElement.classList.toggle('no-anim', !en)
  $('btn-anim').textContent = en ? '🎬 动画' : '🚫 动画'
}

// ================= 初始化 =================
;(async function init() {
  initTheme()
  initAnim()
  await initI18n()
  try {
    const dir = await window.api.defaultStorage()
    $('res-label').textContent = (await window.api.resourceRoots()).find(() => true) || ''
    if (dir) await openDir(dir)
    else showEmptyHint(true)
  } catch (e) {
    showEmptyHint(true)
    setStatus('初始化失败: ' + e.message)
  }
})()
