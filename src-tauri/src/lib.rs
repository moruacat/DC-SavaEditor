// 恶魔连结 存档编辑器 - Tauri 后端命令（文件系统桥接）
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::json;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

// 用户通过界面「资源目录」额外指定的根目录，读取资源时优先查找
static USER_ROOTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

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

// 用户指定资源目录（界面「资源目录」按钮）
#[tauri::command]
fn add_resource_root(dir: String) {
    let mut v = USER_ROOTS.lock().unwrap();
    if !v.contains(&dir) {
        v.push(dir);
    }
}

// 将文件读为 dataURL
fn file_to_data_url(p: &Path, rel: &str) -> Option<String> {
    let data = fs::read(p).ok()?;
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
    Some(format!("data:{};base64,{}", mime, BASE64.encode(data)))
}

// 从游戏资源读取文件，返回 dataURL
fn read_resource_impl(rel: &str) -> Option<String> {
    // 优先查用户「资源目录」指定的根
    if let Ok(roots) = USER_ROOTS.lock() {
        for root in roots.iter() {
            let p = format!("{}/{}", root, rel);
            if Path::new(&p).is_file() {
                return file_to_data_url(Path::new(&p), rel);
            }
        }
    }
    // 再查候选资源根目录
    for root in resource_roots() {
        let p = format!("{}/{}", root, rel);
        if !Path::new(&p).is_file() {
            continue;
        }
        return file_to_data_url(Path::new(&p), rel);
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

// 弹出「导出」保存对话框并写入文本（如明文 JSON），返回是否成功
#[tauri::command]
fn save_text_dialog(app: tauri::AppHandle, content: String, default_name: String) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(default_name)
        .set_title("导出")
        .blocking_save_file();
    let Some(path) = picked else { return Ok(false) };
    let Ok(path) = path.into_path() else { return Ok(false) };
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(true)
}

// 弹出「导入」打开对话框并读文本，返回 {text, name}（JSON 字符串）或 null
#[tauri::command]
fn open_text_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_title("导入")
        .blocking_pick_file();
    let Some(path) = picked else { return Ok(None) };
    let Ok(path) = path.into_path() else { return Ok(None) };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(json!({ "text": text, "name": name }).to_string()))
}

// 递归复制目录
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// 备份目录：把 storage_dir 复制到其父级下的 backup/<时间戳>/
#[tauri::command]
fn backup_storage(storage_dir: String) -> Result<Option<String>, String> {
    let src = Path::new(&storage_dir);
    if !src.is_dir() { return Ok(None) }
    let parent = src.parent().ok_or_else(|| "no parent".to_string())?;
    let backup_root = parent.join("backup");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "backup".to_string());
    let dest = backup_root.join(&ts);
    copy_dir_recursive(src, &dest).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

// 列出 storage_dir 同级 backup/ 下的备份（按名字倒序）
#[tauri::command]
fn list_backups(storage_dir: String) -> Vec<String> {
    let src = Path::new(&storage_dir);
    let Some(parent) = src.parent() else { return Vec::new() };
    let backup_root = parent.join("backup");
    let Ok(entries) = fs::read_dir(&backup_root) else { return Vec::new() };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    dirs.sort();
    dirs.reverse();
    dirs
}

// 还原：把 backup/<name>/ 的内容复制回 storage_dir（覆盖同名、保留其他）
#[tauri::command]
fn restore_storage(storage_dir: String, backup_name: String) -> Result<bool, String> {
    let src = Path::new(&storage_dir).parent()
        .map(|p| p.join("backup").join(&backup_name))
        .ok_or_else(|| "no parent".to_string())?;
    if !src.is_dir() { return Ok(false) }
    copy_dir_recursive(&src, Path::new(&storage_dir)).map_err(|e| e.to_string())?;
    Ok(true)
}

// 删除文件（照片删除用）
#[tauri::command]
fn delete_file(path: String) -> Result<bool, String> {
    let path = path.strip_prefix("file://").unwrap_or(&path);
    match fs::remove_file(path) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false), // 不存在也视为成功删干净
    }
}

// 重启应用（切换语言等需要完全刷新界面的场景）
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
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
            add_resource_root,
            default_storage_dir,
            save_data_url,
            save_image_dialog,
            pick_dir,
            save_text_dialog,
            open_text_dialog,
            backup_storage,
            list_backups,
            restore_storage,
            delete_file,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
