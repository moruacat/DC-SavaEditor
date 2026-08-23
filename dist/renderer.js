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
  // 列表
  const lBox = $('list-fields')
  lBox.innerHTML = ''
  for (const key of SYS_LIST_KEYS) {
    const f = el('div', 'field')
    f.appendChild(el('label', null, key))
    const inp = el('input')
    inp.dataset.key = key
    inp.dataset.field = 'list'
    inp.value = Array.isArray(m[key]) ? m[key].join(', ') : (m[key] || '')
    f.appendChild(inp)
    lBox.appendChild(f)
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
  // 全部解锁/收集快捷
  $('end-unlock-all').onchange = e => {
    $('end-grid').querySelectorAll('input[data-field="end"]').forEach(cb => {
      if (cb.dataset.kind === 'endings') cb.checked = e.target.checked
    })
  }
  $('end-collect-all').onchange = e => {
    $('end-grid').querySelectorAll('input[data-field="end"]').forEach(cb => {
      if (cb.dataset.kind === 'collectedEndings') cb.checked = e.target.checked
    })
  }
  $('stick-all').onchange = e => {
    $('stick-grid').querySelectorAll('input[data-field="stick"]').forEach(cb => { cb.checked = e.target.checked })
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
function renderVarTable(container, data, compact) {
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
  for (const g of VAR_GROUPS) {
    container.appendChild(el('div', 'vt-group', '—— ' + g + ' ——'))
    for (const [name, [desc, grp, type]] of Object.entries(VAR_INFO)) {
      if (grp !== g) continue
      container.appendChild(el('div', 'vt-name', name))
      if (!compact) container.appendChild(el('div', 'vt-desc', desc))
      const cell = el('div', 'vt-val')
      const inp = el('input')
      inp.dataset.var = name
      inp.dataset.vtype = type
      inp.value = fmtVarVal(data[name], type)
      cell.appendChild(inp)
      container.appendChild(cell)
    }
  }
  // 数据中存在但字典未收录的变量
  const extra = Object.keys(data).filter(k => !(k in VAR_INFO) && k !== '_tap_effect')
  if (extra.length) {
    container.appendChild(el('div', 'vt-group', '—— 其它（字典未收录） ——'))
    for (const k of extra) {
      container.appendChild(el('div', 'vt-name', k))
      if (!compact) container.appendChild(el('div', 'vt-desc', ''))
      const cell = el('div', 'vt-val')
      const inp = el('input')
      inp.dataset.var = k
      inp.dataset.vtype = typeof data[k] === 'number' ? 'int' : typeof data[k] === 'boolean' ? 'bool' : (Array.isArray(data[k]) ? 'array' : 'str')
      inp.value = fmtVarVal(data[k], inp.dataset.vtype)
      cell.appendChild(inp)
      container.appendChild(cell)
    }
  }
}
function fmtVarVal(v, type) {
  if (v === undefined || v === null) return ''
  if (type === 'array') return Array.isArray(v) ? v.join(', ') : String(v)
  return String(v)
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
  '<b>槽位存档</b>（DevilConnection_tyrano_data.sav）包含游戏内手动存档的全部槽位（30 个）。' +
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

function loadSlots(path, obj) {
  S.slots = { path, obj }
  S.activeEntry = { path, kind: 'slots' }
  S.currentPanel = 'slots'
  $('slot-hint').innerHTML = SLOT_HINT
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
  renderVarTable($('slot-vars'), f, true)
}

// ================= 快速/自动存档（单存档） =================
function loadSingle(path, obj) {
  S.slots = { path, obj, single: true }
  S.activeEntry = { path, kind: 'single' }
  $('slot-hint').innerHTML = SLOT_HINT
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
  renderVarTable($('slot-vars'), f, true)
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
  document.querySelectorAll('#list-fields input').forEach(inp => {
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
  } catch (err) {
    setStatus('保存失败: ' + err.message)
  }
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
$('btn-resource').onclick = async () => {
  const dir = await window.api.pickDir()
  if (dir) {
    $('res-label').textContent = dir
    $('res-label').title = dir
  }
}
$('modal-close').onclick = () => $('modal').classList.add('hidden')
$('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').classList.add('hidden') })
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').classList.add('hidden') })

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
