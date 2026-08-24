// 恶魔连结 存档编辑器 - 平台桥接
// 自动识别运行环境：Tauri（window.__TAURI__，withGlobalTauri 注入）或 Electron（window.electronAPI，preload 注入）
// 无论哪种环境，都向 renderer.js 暴露统一的 window.api 接口
;(function () {
  if (window.__TAURI__ && window.__TAURI__.core) {
    // ---------- Tauri 后端 ----------
    window.api = {
      listDir: async dir => JSON.parse(await window.__TAURI__.core.invoke('list_dir', { dir })),
      readText: path => window.__TAURI__.core.invoke('read_text', { path }),
      writeText: (path, text) => window.__TAURI__.core.invoke('write_text', { path, text }),
      readResource: relPath => window.__TAURI__.core.invoke('read_resource', { relPath }),
      saveImage: (dataUrl, name) => window.__TAURI__.core.invoke('save_image_dialog', { dataUrl, defaultName: name }),
      pickDir: () => window.__TAURI__.core.invoke('pick_dir'),
      defaultStorage: () => window.__TAURI__.core.invoke('default_storage_dir'),
      resourceRoots: () => window.__TAURI__.core.invoke('resource_roots_cmd'),
      addResourceRoot: dir => window.__TAURI__.core.invoke('add_resource_root', { dir }),
    }
  } else if (window.electronAPI) {
    // ---------- Electron 后端（由 preload.js 通过 contextBridge 注入） ----------
    window.api = window.electronAPI
  }
})()
