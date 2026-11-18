//! Backend for Midterm Grader.
//!
//! The Canvas token lives only on this side: the web UI asks for Canvas API paths and
//! this code attaches the token, and only ever sends it to the configured Canvas host.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LOGIN_LABEL: &str = "canvas-login";

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    base_url: String,
    #[serde(default)]
    token: String,
    /// "token" (personal access token) or "session" (signed in through the in-app Canvas login)
    #[serde(default)]
    auth_mode: String,
    /// Canvas session cookies from the in-app sign-in, kept so the sign-in survives restarts
    /// (Canvas's session cookie has no expiry, so the webview drops it on quit). Cleared on sign-out
    /// or when Canvas says the session has ended.
    #[serde(default)]
    session: Vec<(String, String)>,
}

/// What the UI sees: never the token itself, just whether one is saved.
#[derive(Serialize)]
struct PublicSettings {
    base_url: String,
    has_token: bool,
    auth_mode: String,
}

impl From<&Settings> for PublicSettings {
    fn from(s: &Settings) -> Self {
        let mode = if s.auth_mode == "session" { "session" } else if !s.token.is_empty() { "token" } else { "" };
        PublicSettings { base_url: s.base_url.clone(), has_token: !s.token.is_empty(), auth_mode: mode.into() }
    }
}

/// Serializes settings read-modify-write so parallel requests can't interleave saves.
static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Atomic save: write a private temp file, then rename it over settings.json.
fn write_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let dir = config_dir(app)?;
    let path = dir.join("settings.json");
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!("settings.json.{}.{n}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string_pretty(s).unwrap().as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Read, change and save settings under the lock. `f` returns whether anything changed.
fn update_settings(app: &AppHandle, f: impl FnOnce(&mut Settings) -> bool) -> Result<Settings, String> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = read_settings(app)?;
    if f(&mut s) { write_settings(app, &s)?; }
    Ok(s)
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
    Ok((&read_settings(&app)?).into())
}

/// Use a personal access token: save the Canvas URL, and the token if one is given
/// (empty keeps the saved token).
#[tauri::command]
fn save_settings(app: AppHandle, base_url: String, token: Option<String>) -> Result<PublicSettings, String> {
    let mut s = read_settings(&app)?;
    s.base_url = normalize_base(&base_url)?;
    if let Some(t) = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        s.token = t;
    }
    s.auth_mode = "token".into();
    write_settings(&app, &s)?;
    Ok((&s).into())
}

#[tauri::command]
fn forget_token(app: AppHandle) -> Result<(), String> {
    let mut s = read_settings(&app)?;
    s.token.clear();
    if s.auth_mode == "token" {
        s.auth_mode.clear();
    }
    write_settings(&app, &s)
}

// ---------- signing in with the Canvas login page instead of a token ----------
//
// The login window is an ordinary browser window with no access to the app's commands (it isn't
// listed in capabilities/default.json). It shares the app's cookie store, so once the user has
// signed in, the backend reads the Canvas cookies from that store and sends them to Canvas only.

struct SessionCookies {
    header: String,
    csrf: Option<String>,
}

/// Cookies for the Canvas host. Runs off the main thread: reading cookies from a sync context
/// deadlocks on Windows (WebView2).
fn is_session_cookie(name: &str) -> bool {
    name == "canvas_session" || name == "_normandy_session" || name == "_legacy_normandy_session"
}

/// Canvas cookies currently in the app's webview (empty after a restart, see Settings::session).
async fn webview_cookies(app: &AppHandle, base: &str) -> Result<Vec<(String, String)>, String> {
    let url = url::Url::parse(&format!("{base}/")).map_err(|e| e.to_string())?;
    let app = app.clone();
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        let wv = app.get_webview_window("main").ok_or("main window missing")?;
        wv.cookies_for_url(url).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(cookies.iter().map(|c| (c.name().to_string(), c.value().to_string())).collect())
}

fn to_session(pairs: &[(String, String)]) -> SessionCookies {
    let header = pairs.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ");
    let csrf = pairs.iter().find(|(n, _)| n == "_csrf_token")
        .map(|(_, v)| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned());
    SessionCookies { header, csrf }
}

/// The Canvas session to use: the webview's live cookies if it has them (saved for next time),
/// otherwise the ones saved from an earlier sign-in.
async fn session_cookies(app: &AppHandle, base: &str) -> Result<Option<SessionCookies>, String> {
    let live = webview_cookies(app, base).await?;
    if live.iter().any(|(n, _)| is_session_cookie(n)) {
        let _ = update_settings(app, |s| {
            if s.auth_mode == "session" && s.session != live { s.session = live.clone(); true } else { false }
        });
        return Ok(Some(to_session(&live)));
    }
    let s = read_settings(app)?;
    if s.auth_mode == "session" && s.session.iter().any(|(n, _)| is_session_cookie(n)) {
        return Ok(Some(to_session(&s.session)));
    }
    Ok(None)
}

/// Canvas refreshes its cookies on responses; keep the saved copy current.
fn refresh_saved_session(app: &AppHandle, headers: &reqwest::header::HeaderMap) {
    let updates: Vec<(String, String)> = headers.get_all("set-cookie").iter().filter_map(|h| {
        let (name, rest) = h.to_str().ok()?.split_once('=')?;
        let value = rest.split(';').next().unwrap_or("").to_string();
        (!value.is_empty()).then(|| (name.trim().to_string(), value))
    }).collect();
    if updates.is_empty() { return; }
    let _ = update_settings(app, |s| {
        if s.auth_mode != "session" || s.session.is_empty() { return false; }
        let mut changed = false;
        for (name, value) in &updates {
            if let Some(slot) = s.session.iter_mut().find(|(n, _)| n == name) {
                if &slot.1 != value { slot.1 = value.clone(); changed = true; }
            }
        }
        changed
    });
}

/// Canvas says the session has ended: forget the saved copy.
fn forget_saved_session(app: &AppHandle) {
    let _ = update_settings(app, |s| { let had = !s.session.is_empty(); s.session.clear(); had });
}

mod nq;

/// Opens the Canvas login page in its own window.
#[tauri::command]
async fn open_login(app: AppHandle, base_url: String) -> Result<(), String> {
    let base = normalize_base(&base_url)?;
    let mut s = read_settings(&app)?;
    s.base_url = base.clone();
    write_settings(&app, &s)?;
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = url::Url::parse(&format!("{base}/login")).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Sign in to Canvas")
        .inner_size(520.0, 760.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct LoginStatus {
    /// "pending" (still signing in), "closed" (window closed before signing in), "ok"
    state: String,
    name: Option<String>,
    settings: Option<PublicSettings>,
}

/// Polled while the login window is open: has the user finished signing in?
#[tauri::command]
async fn check_login(app: AppHandle, http: tauri::State<'_, Http>) -> Result<LoginStatus, String> {
    let mut s = read_settings(&app)?;
    let window_open = app.get_webview_window(LOGIN_LABEL).is_some();
    let pending = |open: bool| LoginStatus { state: if open { "pending" } else { "closed" }.into(), name: None, settings: None };
    let Some(c) = session_cookies(&app, &s.base_url).await? else { return Ok(pending(window_open)) };
    let resp = http.0.get(format!("{}/api/v1/users/self", s.base_url))
        .header("Cookie", &c.header).header("Accept", "application/json")
        .send().await.map_err(|e| format!("Network error: {e}"))?;
    if !resp.status().is_success() {
        return Ok(pending(window_open));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let me: Value = serde_json::from_str(strip_json_guard(&text)).unwrap_or(Value::Null);
    s.auth_mode = "session".into();
    s.session = webview_cookies(&app, &s.base_url).await.unwrap_or_default();
    write_settings(&app, &s)?;
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }
    Ok(LoginStatus { state: "ok".into(), name: me.get("name").and_then(|n| n.as_str()).map(String::from), settings: Some((&s).into()) })
}

/// Signs out of Canvas in this app: deletes the Canvas cookies (and nothing else).
#[tauri::command]
async fn sign_out(app: AppHandle) -> Result<PublicSettings, String> {
    let mut s = read_settings(&app)?;
    if !s.base_url.is_empty() {
        let url = url::Url::parse(&format!("{}/", s.base_url)).map_err(|e| e.to_string())?;
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let wv = app2.get_webview_window("main").ok_or("main window missing")?;
            for c in wv.cookies_for_url(url).map_err(|e| e.to_string())? {
                let _ = wv.delete_cookie(c);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }
    if s.auth_mode == "session" {
        s.auth_mode.clear();
    }
    s.session.clear();
    write_settings(&app, &s)?;
    Ok((&s).into())
}

/// Canvas prefixes JSON with `while(1);` for cookie-authenticated requests.
fn strip_json_guard(text: &str) -> &str {
    text.trim_start().strip_prefix("while(1);").unwrap_or(text)
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
    let base = settings.base_url.clone();
    let session = settings.auth_mode == "session";
    let cookies = if session {
        match session_cookies(&app, &base).await? {
            Some(c) => Some(c),
            None => return Err("SIGNED_OUT: Sign in to Canvas again.".into()),
        }
    } else {
        None
    };
    if base.is_empty() || (!session && settings.token.is_empty()) {
        return Err("Not connected: sign in to Canvas first.".into());
    }
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
        let mut rb = http.0.request(method.clone(), &url).header("Accept", "application/json");
        rb = match &cookies {
            Some(c) => {
                let rb = rb.header("Cookie", &c.header);
                match (&c.csrf, method != reqwest::Method::GET) {
                    (Some(t), true) => rb.header("X-CSRF-Token", t),
                    _ => rb,
                }
            }
            None => rb.bearer_auth(&settings.token),
        };
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
        if session { refresh_saved_session(&app, resp.headers()); }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            if session && status.as_u16() == 401 {
                forget_saved_session(&app);
                return Err("SIGNED_OUT: Your Canvas session has expired. Sign in again.".into());
            }
            let snippet: String = text.chars().take(400).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
        }
        let body = strip_json_guard(&text);
        let value: Value = if body.trim().is_empty() { Value::Null } else { serde_json::from_str(body).map_err(|e| format!("Bad JSON from Canvas: {e}"))? };
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
        .manage(nq::NqState::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            forget_token,
            open_login,
            check_login,
            sign_out,
            nq::nq_open,
            nq::nq_lti,
            nq::nq_attempt,
            nq::nq_quiz,
            canvas,
            read_text_file,
            write_text_file,
            save_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
