// 恶魔连结 存档编辑器 - Tauri 后端命令（文件系统桥接）
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::json;
use std::fs;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

// 列出目录内容，返回 JSON 字符串: [{"name","dir","size","mtime","full"}, ...]
#[tauri::command]
fn list_dir(dir: String) -> Result<String, String> {
    let mut arr = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        let meta = p.metadata().ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        arr.push(json!({
            "name": p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "dir": p.is_dir(),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "mtime": mtime,
            "full": p.to_string_lossy().into_owned(),
        }));
    }
    serde_json::to_string(&arr).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, text: String) -> Result<bool, String> {
    fs::write(&path, text).map(|_| true).map_err(|e| e.to_string())
}

// 候选游戏资源根目录
fn resource_roots() -> Vec<String> {
    let exe = std::env::current_exe().unwrap_or_default();
    let mut roots: Vec<String> = Vec::new();
    let mut cur = exe.parent().map(|p| p.to_path_buf());
    for _ in 0..8 {
        if let Some(d) = cur {
            let base = d.to_string_lossy().into_owned();
            roots.push(format!("{}/_Unpacked/app.asar_extracted", base));
            roots.push(format!("{}/resources/app.asar", base));
            roots.push(base.clone());
            cur = d.parent().map(|p| p.to_path_buf());
        }
    }
    // 可选：通过环境变量 DC_GAME_ROOT 指定游戏根目录（脱敏：不硬编码本机路径）
    if let Ok(root) = std::env::var("DC_GAME_ROOT") {
        roots.push(format!("{}/_Unpacked/app.asar_extracted", root));
        roots.push(format!("{}/resources/app.asar", root));
    }
    roots.sort();
    roots.dedup();
    roots
}

#[tauri::command]
fn resource_roots_cmd() -> Vec<String> {
    resource_roots()
}

// 从游戏资源读取文件，返回 dataURL
fn read_resource_impl(rel: &str) -> Option<String> {
    for root in resource_roots() {
        let p = format!("{}/{}", root, rel);
        if !Path::new(&p).is_file() {
            continue;
        }
        let data = fs::read(&p).ok()?;
        let ext = Path::new(rel)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        return Some(format!("data:{};base64,{}", mime, BASE64.encode(data)));
    }
    None
}

#[tauri::command]
fn read_resource(rel_path: String) -> Result<String, String> {
    read_resource_impl(&rel_path).ok_or_else(|| "resource not found".to_string())
}

// 默认存档目录
#[tauri::command]
fn default_storage_dir() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let mut cur = exe.parent().map(|p| p.to_path_buf());
    for _ in 0..8 {
        if let Some(d) = cur {
            let cand = format!("{}/_storage", d.to_string_lossy());
            if Path::new(&cand).is_dir() {
                return cand;
            }
            cur = d.parent().map(|p| p.to_path_buf());
        }
    }
    // 可选：环境变量 DC_GAME_ROOT 指向游戏根目录（脱敏：不硬编码本机路径）
    if let Ok(root) = std::env::var("DC_GAME_ROOT") {
        let cand = format!("{}/_storage", root);
        if Path::new(&cand).is_dir() {
            return cand;
        }
    }
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// 将 dataURL 保存为文件
#[tauri::command]
fn save_data_url(data_url: String, path: String) -> Result<bool, String> {
    let path = path.strip_prefix("file://").unwrap_or(&path).to_string();
    let idx = data_url
        .find(";base64,")
        .ok_or_else(|| "invalid data url".to_string())?;
    let b64 = &data_url[idx + 8..];
    let bytes = BASE64.decode(b64).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map(|_| true).map_err(|e| e.to_string())
}

// 弹出保存对话框并写入 dataURL，返回是否成功
#[tauri::command]
fn save_image_dialog(app: tauri::AppHandle, data_url: String, default_name: String) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(path) = picked else { return Ok(false) };
    let Ok(path) = path.into_path() else { return Ok(false) };
    let path = path.to_string_lossy().into_owned();
    save_data_url(data_url, path)
}

// 弹出目录选择对话框，返回路径或 null
#[tauri::command]
fn pick_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text,
            write_text,
            read_resource,
            resource_roots_cmd,
            default_storage_dir,
            save_data_url,
            save_image_dialog,
            pick_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
