//! New Quizzes access, the way Canvas's own New Quizzes page does it.
//!
//! 1. Canvas: a sessionless launch link for the assignment → the launch page, whose ENV holds
//!    the signed New Quizzes launch parameters (NEW_QUIZZES.params + signature).
//! 2. Canvas: POST /api/v1/jwts (workflow new_quizzes_native_launch) → a short-lived JWT.
//! 3. New Quizzes (LTI backend): POST /api/native/launch with the JWT, params and signature →
//!    an access token for the LTI API (students, attempts).
//! 4. Per attempt, GET /api/participant_sessions/:id/grade → the Quiz API host and a token for
//!    that attempt, which serves per-question results and accepts grading.
//!
//! None of these tokens leave this module: the UI refers to a launched quiz by its key and to an
//! attempt by its quiz session id. Requests only go to https *.instructure.com hosts, and the only
//! write allowed is posting an attempt's results (what SpeedGrader does when a grader saves).

use reqwest::{cookie::Jar, Method};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tauri::AppHandle;

use super::{read_settings, session_cookies, strip_json_guard, Http};

/// Dev builds only: append what New Quizzes returned to <app data>/nq-debug.log, for debugging the
/// loader. Only LTI/Quiz API read responses (student lists, results) are logged; those carry no tokens.
#[cfg(debug_assertions)]
fn debug_log(app: &AppHandle, label: &str, v: &Value, reset: bool) {
    use std::io::Write;
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("nq-debug.log");
    let mut f = match std::fs::OpenOptions::new().create(true).write(true).append(!reset).truncate(reset).open(&path) { Ok(f) => f, Err(_) => return };
    let _ = writeln!(f, "===== {label}\n{}\n", serde_json::to_string_pretty(v).unwrap_or_default());
}
#[cfg(not(debug_assertions))]
fn debug_log(_: &AppHandle, _: &str, _: &Value, _: bool) {}

#[derive(Default)]
pub struct NqState(Mutex<HashMap<String, Launch>>);

#[derive(Clone)]
struct Launch {
    backend: String,
    x_domain: String,
    access: String,
    /// quiz session id → (Quiz API host, token)
    attempts: HashMap<String, (String, String)>,
}

#[derive(Serialize)]
pub struct NqInfo {
    key: String,
    lti_assignment_id: String,
    read_only: bool,
    title: Option<String>,
}

fn check_host(url: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|e| format!("bad URL from New Quizzes: {e}"))?;
    let host = u.host_str().unwrap_or("");
    if u.scheme() == "https" && (host == "instructure.com" || host.ends_with(".instructure.com")) {
        Ok(())
    } else {
        Err(format!("refusing to contact unexpected host {host}"))
    }
}

/// The JSON object that follows `key` in text (balanced braces, string-aware).
fn json_after(text: &str, key: &str) -> Option<Value> {
    let i = text.find(key)? + key.len();
    let start = i + text[i..].find('{')?;
    let b = text.as_bytes();
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    for (k, &c) in b.iter().enumerate().skip(start) {
        if in_str {
            if esc { esc = false } else if c == b'\\' { esc = true } else if c == b'"' { in_str = false }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&text[start..=k]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn as_id(v: &Value) -> Option<String> {
    v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string()))
}

fn next_link(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let link = headers.get("link")?.to_str().ok()?;
    link.split(',').find_map(|part| {
        let mut bits = part.split(';');
        let url = bits.next()?.trim().trim_start_matches('<').trim_end_matches('>');
        bits.any(|b| b.trim() == "rel=\"next\"").then(|| url.to_string())
    })
}

/// Send, follow Link pagination (same host only), return JSON. Array pages are concatenated.
async fn send(client: &reqwest::Client, method: Method, url: String, headers: &[(&str, String)], body: Option<&Value>, paginate: bool) -> Result<Value, String> {
    check_host(&url)?;
    let origin = { let u = url::Url::parse(&url).unwrap(); format!("{}://{}/", u.scheme(), u.host_str().unwrap_or("")) };
    let mut url = url;
    let mut pages = vec![];
    loop {
        let mut rb = client.request(method.clone(), &url).header("Accept", "application/json");
        for (k, v) in headers { rb = rb.header(*k, v); }
        if let Some(b) = body { rb = rb.json(b); }
        let resp = rb.send().await.map_err(|e| format!("Network error: {e}"))?;
        let status = resp.status();
        let next = next_link(resp.headers());
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let snippet: String = text.chars().take(300).collect();
            return Err(format!("New Quizzes returned HTTP {}: {snippet}", status.as_u16()));
        }
        let body_txt = strip_json_guard(&text);
        let v: Value = if body_txt.trim().is_empty() { Value::Null } else { serde_json::from_str(body_txt).map_err(|e| format!("Bad JSON from New Quizzes: {e}"))? };
        if !paginate { return Ok(v); }
        pages.push(v);
        match next {
            Some(n) if n.starts_with(&origin) && pages.len() < 200 => url = n,
            _ => break,
        }
    }
    if pages.iter().all(|p| p.is_array()) {
        Ok(Value::Array(pages.into_iter().flat_map(|p| p.as_array().cloned().unwrap_or_default()).collect()))
    } else {
        Ok(Value::Array(pages))
    }
}

/// A request to Canvas with the user's sign-in (session cookies + CSRF, or their token).
async fn canvas_req(app: &AppHandle, client: &reqwest::Client, method: Method, url: &str) -> Result<reqwest::RequestBuilder, String> {
    let s = read_settings(app)?;
    let rb = client.request(method.clone(), url).header("Accept", "application/json");
    if s.auth_mode == "session" {
        let c = session_cookies(app, &s.base_url).await?.ok_or("SIGNED_OUT: Sign in to Canvas again.")?;
        let rb = rb.header("Cookie", c.header);
        Ok(match (c.csrf, method != Method::GET) { (Some(t), true) => rb.header("X-CSRF-Token", t), _ => rb })
    } else if !s.token.is_empty() {
        Ok(rb.bearer_auth(s.token))
    } else {
        Err("Not connected: sign in to Canvas first.".into())
    }
}

async fn canvas_json(rb: reqwest::RequestBuilder, what: &str) -> Result<Value, String> {
    let resp = rb.send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 { return Err(format!("SIGNED_OUT: Canvas refused {what} (401). Sign in again.")); }
    if !status.is_success() { return Err(format!("Canvas {what}: HTTP {}: {}", status.as_u16(), text.chars().take(300).collect::<String>())); }
    serde_json::from_str(strip_json_guard(&text)).map_err(|e| format!("Canvas {what}: bad JSON: {e}"))
}

/// Launch New Quizzes for a Canvas assignment and remember the access it grants.
#[tauri::command]
pub async fn nq_open(app: AppHandle, http: tauri::State<'_, Http>, state: tauri::State<'_, NqState>, course_id: String, assignment_id: String) -> Result<NqInfo, String> {
    let base = read_settings(&app)?.base_url;
    if !course_id.chars().all(|c| c.is_ascii_digit()) || !assignment_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("bad course or assignment id".into());
    }
    // 1. Sessionless launch → launch page with the signed params.
    let rb = canvas_req(&app, &http.0, Method::GET, &format!(
        "{base}/api/v1/courses/{course_id}/external_tools/sessionless_launch?launch_type=assessment&assignment_id={assignment_id}")).await?;
    let launch = canvas_json(rb, "the launch link").await?;
    let launch_url = launch.get("url").and_then(|u| u.as_str()).ok_or("Canvas didn't return a launch link")?.to_string();
    if !launch_url.starts_with(&format!("{base}/")) { return Err("unexpected launch link".into()); }
    // Open the launch page as the signed-in user (like the browser does): with session sign-in,
    // carry the Canvas session cookies; the launch link alone doesn't render the New Quizzes page.
    let jar = Arc::new(Jar::default());
    if read_settings(&app)?.auth_mode == "session" {
        if let Some(c) = session_cookies(&app, &base).await? {
            let base_url = url::Url::parse(&base).map_err(|e| e.to_string())?;
            for pair in c.header.split("; ") {
                jar.add_cookie_str(&format!("{pair}; Path=/; Secure"), &base_url);
            }
        }
    }
    let browser = reqwest::Client::builder()
        .cookie_provider(jar)
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")
        .build().map_err(|e| e.to_string())?;
    let page = browser.get(&launch_url).send().await.map_err(|e| format!("Network error: {e}"))?;
    let final_url = page.url().to_string();
    let html = page.text().await.map_err(|e| e.to_string())?;
    let nq = json_after(&html, "\"NEW_QUIZZES\":").ok_or_else(|| {
        if final_url.contains("/login") { "Canvas asked for a login when opening the quiz. Sign in again.".to_string() }
        else {
            // Say what came back instead (title and path only; no query, which can hold tokens).
            let title = html.find("<title>").and_then(|i| html[i + 7..].find("</title>").map(|j| html[i + 7..i + 7 + j].trim().to_string())).unwrap_or_default();
            let path = url::Url::parse(&final_url).map(|u| u.path().to_string()).unwrap_or_default();
            format!("This assignment didn't open as a New Quiz (Canvas returned \"{title}\" at {path}).")
        }
    })?;
    let params = nq.get("params").cloned().ok_or("launch parameters missing")?;
    let signature = nq.get("signature").cloned().ok_or("launch signature missing")?;
    let backend = params.get("backend_url").and_then(|v| v.as_str()).ok_or("New Quizzes address missing")?.trim_end_matches('/').to_string();
    check_host(&backend)?;
    let x_domain = params.get("tool_consumer_instance_guid").and_then(|v| v.as_str()).and_then(|g| g.split(':').next()).unwrap_or("").to_string();
    let title = params.get("resource_link_title").and_then(|v| v.as_str()).map(String::from);
    let account: String = {
        let i = html.find("\"ACCOUNT_ID\":").ok_or("account id missing from launch page")? + 13;
        html[i..].trim_start_matches(['"', ' ']).chars().take_while(|c| c.is_ascii_digit()).collect()
    };

    // 2. Canvas JWT for the native launch.
    let rb = canvas_req(&app, &http.0, Method::POST, &format!("{base}/api/v1/jwts")).await?
        .json(&json!({ "canvas_audience": false, "workflows": ["new_quizzes_native_launch"], "context_id": account, "context_type": "account" }));
    let jwt = canvas_json(rb, "the New Quizzes launch token").await?;
    let jwt = jwt.get("token").and_then(|t| t.as_str()).ok_or("Canvas didn't return a launch token")?.to_string();

    // 3. New Quizzes native launch.
    let launched = send(&http.0, Method::POST, format!("{backend}/api/native/launch"),
        &[("Authorization", format!("Bearer {jwt}")), ("X-Domain", x_domain.clone())],
        Some(&json!({ "params": params, "signature": signature })), false).await?;
    let access = launched.get("access_token").and_then(|v| v.as_str()).ok_or("New Quizzes didn't grant access")?.to_string();
    let lti_assignment_id = launched.get("entry_path").and_then(|e| e.get("resourceId")).and_then(as_id)
        .ok_or("New Quizzes didn't say which quiz this is")?;
    let read_only = launched.get("read_only_mode").and_then(|v| v.as_bool()).unwrap_or(false);

    debug_log(&app, &format!("launch {course_id}:{assignment_id} lti={lti_assignment_id} read_only={read_only}"), &Value::Null, true);
    let key = format!("{course_id}:{assignment_id}");
    state.0.lock().unwrap().insert(key.clone(), Launch { backend, x_domain, access, attempts: HashMap::new() });
    Ok(NqInfo { key, lti_assignment_id, read_only, title })
}

fn launch_for(state: &NqState, key: &str) -> Result<Launch, String> {
    state.0.lock().unwrap().get(key).cloned().ok_or_else(|| "New Quizzes session expired; reload the quiz.".into())
}

/// GET from the New Quizzes LTI API (students, attempts). `path` starts with /api/.
#[tauri::command]
pub async fn nq_lti(app: AppHandle, http: tauri::State<'_, Http>, state: tauri::State<'_, NqState>, key: String, path: String, paginate: Option<bool>) -> Result<Value, String> {
    if !path.starts_with("/api/") || path.contains("..") { return Err("invalid path".into()); }
    let l = launch_for(&state, &key)?;
    let v = send(&http.0, Method::GET, format!("{}{}", l.backend, path),
        &[("Authorization", format!("Bearer {}", l.access)), ("X-Domain", l.x_domain.clone())], None, paginate.unwrap_or(false)).await?;
    debug_log(&app, &format!("LTI GET {path}"), &v, false);
    Ok(v)
}

/// Open one attempt for grading; returns its quiz session id.
#[tauri::command]
pub async fn nq_attempt(http: tauri::State<'_, Http>, state: tauri::State<'_, NqState>, key: String, participant_session_id: String) -> Result<String, String> {
    if !participant_session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("bad attempt id".into()); }
    let l = launch_for(&state, &key)?;
    let g = send(&http.0, Method::GET, format!("{}/api/participant_sessions/{participant_session_id}/grade", l.backend),
        &[("Authorization", format!("Bearer {}", l.access)), ("X-Domain", l.x_domain.clone())], None, false).await?;
    let host = g.get("host").and_then(|v| v.as_str()).ok_or("no Quiz API host")?.trim_end_matches('/').to_string();
    check_host(&host)?;
    let token = g.get("token").and_then(|v| v.as_str()).ok_or("no Quiz API token")?.to_string();
    let qsid = g.get("quiz_api_quiz_session_id").and_then(as_id).ok_or("no quiz session id")?;
    if let Some(l) = state.0.lock().unwrap().get_mut(&key) { l.attempts.insert(qsid.clone(), (host, token)); }
    Ok(qsid)
}

/// Quiz API request for one opened attempt. GET anything under /api/quiz_sessions/<id>; the only
/// write allowed is POST /api/quiz_sessions/<id>/results (saving grades, as SpeedGrader does).
#[tauri::command]
pub async fn nq_quiz(app: AppHandle, http: tauri::State<'_, Http>, state: tauri::State<'_, NqState>, key: String, quiz_session_id: String, method: String, path: String, body: Option<Value>, paginate: Option<bool>) -> Result<Value, String> {
    let scope = format!("/api/quiz_sessions/{quiz_session_id}");
    if !(path == scope || path.starts_with(&format!("{scope}/"))) || path.contains("..") { return Err("invalid path".into()); }
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" if path == format!("{scope}/results") => Method::POST,
        _ => return Err("only reading, or saving an attempt's results, is allowed".into()),
    };
    let l = launch_for(&state, &key)?;
    let (host, token) = l.attempts.get(&quiz_session_id).cloned().ok_or("attempt not opened")?;
    let is_get = method == Method::GET;
    let v = send(&http.0, method, format!("{host}{path}"), &[("Authorization", token), ("AuthType", "Signature".into())],
        body.as_ref(), paginate.unwrap_or(false)).await?;
    if is_get && !path.ends_with("/session_items") { debug_log(&app, &format!("QUIZ GET {path}"), &v, false); }
    Ok(v)
}
