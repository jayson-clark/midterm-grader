//! Backend for Midterm Grader.
//!
//! The Canvas token lives only on this side: the web UI asks for Canvas API paths and
//! this code attaches the token, and only ever sends it to the configured Canvas host.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    base_url: String,
    token: String,
}

/// What the UI sees: never the token itself, just whether one is saved.
#[derive(Serialize)]
struct PublicSettings {
    base_url: String,
    has_token: bool,
}

struct Http(reqwest::Client);

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = config_dir(app)?.join("settings.json");
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("settings.json: {e}")),
        Err(_) => Ok(Settings::default()),
    }
}

fn normalize_base(url: &str) -> Result<String, String> {
    let mut s = url.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("Canvas URL is empty".into());
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = format!("https://{s}");
    }
    let parsed = url::Url::parse(&s).map_err(|e| format!("Bad Canvas URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Canvas URL must use https".into());
    }
    Ok(format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or_default()))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<PublicSettings, String> {
    let s = read_settings(&app)?;
    Ok(PublicSettings { base_url: s.base_url, has_token: !s.token.is_empty() })
}

/// Save the Canvas URL, and the token if one is given (empty keeps the saved token).
#[tauri::command]
fn save_settings(app: AppHandle, base_url: String, token: Option<String>) -> Result<PublicSettings, String> {
    let mut s = read_settings(&app)?;
    s.base_url = normalize_base(&base_url)?;
    if let Some(t) = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        s.token = t;
    }
    let path = config_dir(&app)?.join("settings.json");
    fs::write(&path, serde_json::to_string_pretty(&s).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(PublicSettings { base_url: s.base_url, has_token: !s.token.is_empty() })
}

#[tauri::command]
fn forget_token(app: AppHandle) -> Result<(), String> {
    let mut s = read_settings(&app)?;
    s.token.clear();
    let path = config_dir(&app)?.join("settings.json");
    fs::write(&path, serde_json::to_string_pretty(&s).unwrap()).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct CanvasRequest {
    method: Option<String>,
    /// "/courses/1/..." (prefixed with /api/v1) or a full "/api/..." path.
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
    /// Follow Link: rel="next" headers. Array pages are concatenated; object pages are
    /// returned as an array of pages.
    paginate: Option<bool>,
}

fn next_link(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let link = headers.get("link")?.to_str().ok()?;
    link.split(',').find_map(|part| {
        let mut bits = part.split(';');
        let url = bits.next()?.trim().trim_start_matches('<').trim_end_matches('>');
        bits.any(|b| b.trim() == "rel=\"next\"").then(|| url.to_string())
    })
}

#[tauri::command]
async fn canvas(app: AppHandle, http: tauri::State<'_, Http>, req: CanvasRequest) -> Result<Value, String> {
    let settings = read_settings(&app)?;
    if settings.base_url.is_empty() || settings.token.is_empty() {
        return Err("Not connected: add your Canvas URL and access token first.".into());
    }
    let base = settings.base_url.clone();
    let path = if req.path.starts_with("/api/") { req.path.clone() } else { format!("/api/v1{}", req.path) };
    if path.contains("..") || path.contains("://") {
        return Err("Invalid API path".into());
    }
    let method = reqwest::Method::from_bytes(req.method.as_deref().unwrap_or("GET").to_uppercase().as_bytes())
        .map_err(|e| e.to_string())?;

    let mut url = format!("{base}{path}");
    let mut first = true;
    let mut pages: Vec<Value> = Vec::new();
    loop {
        let mut rb = http.0.request(method.clone(), &url).bearer_auth(&settings.token).header("Accept", "application/json");
        if first {
            if let Some(q) = &req.query {
                rb = rb.query(q);
            }
            if let Some(b) = &req.body {
                rb = rb.json(b);
            }
        }
        let resp = rb.send().await.map_err(|e| format!("Network error: {e}"))?;
        let status = resp.status();
        let next = next_link(resp.headers());
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let snippet: String = text.chars().take(400).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
        }
        let value: Value = if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).map_err(|e| format!("Bad JSON from Canvas: {e}"))? };
        if !req.paginate.unwrap_or(false) {
            return Ok(value);
        }
        pages.push(value);
        first = false;
        match next {
            // Only follow pagination links that stay on the Canvas host.
            Some(n) if n.starts_with(&format!("{base}/")) => url = n,
            _ => break,
        }
        if pages.len() > 500 {
            return Err("Too many pages".into());
        }
    }
    if pages.iter().all(|p| p.is_array()) {
        Ok(Value::Array(pages.into_iter().flat_map(|p| p.as_array().cloned().unwrap_or_default()).collect()))
    } else {
        Ok(Value::Array(pages))
    }
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Saves a JSON backup into the app's data folder and returns its path.
#[tauri::command]
fn save_backup(app: AppHandle, name: String, contents: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}.json"));
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::builder()
        .user_agent("MidtermGrader/0.1")
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("http client");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Http(client))
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            forget_token,
            canvas,
            read_text_file,
            write_text_file,
            save_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
