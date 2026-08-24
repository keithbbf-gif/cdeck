#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! cDeck — native Windows shell for the COSMOS HTTP API.
//!
//! The webview never talks to COSMOS directly (CORS + hang risk). All
//! `/api/v1/*` traffic goes through `api_request`, which enforces timeouts
//! so a down server is reported instead of freezing the deck.
//! The bearer token is an argument to each call and is never written to disk.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const DEFAULT_URL: &str = "http://127.0.0.1:8791";
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    /// COSMOS base URL (loopback / LAN / Tailscale). No secrets.
    server_url: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_URL.to_string(),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join("config.json"))
}

fn sanitize_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err("server URL is required".into());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("server URL must start with http:// or https://".into());
    }
    // Refuse embedded credentials so a pasted `http://user:token@host` cannot
    // land on disk. The bearer field is the only place a secret may live, and
    // it is memory-only.
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url.as_str());
    if rest.contains('@') {
        return Err("server URL must not contain credentials (user:pass@host)".into());
    }
    Ok(url)
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read config: {e}"))?;
    let mut cfg: AppConfig = serde_json::from_str(&raw).unwrap_or_default();
    if cfg.server_url.trim().is_empty() {
        cfg.server_url = DEFAULT_URL.to_string();
    }
    Ok(cfg)
}

#[tauri::command]
fn save_config(app: AppHandle, server_url: String) -> Result<AppConfig, String> {
    let cfg = AppConfig {
        server_url: sanitize_url(&server_url)?,
    };
    let path = config_path(&app)?;
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write config: {e}"))?;
    Ok(cfg)
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    ok: bool,
    json: serde_json::Value,
}

fn transport_err(base: &str, err: reqwest::Error) -> String {
    if err.is_timeout() {
        return format!("timeout after 8s — COSMOS at {base} did not answer (server may be down)");
    }
    if err.is_connect() {
        return format!("server down — cannot reach {base} ({err})");
    }
    format!("unreachable — {err}")
}

#[tauri::command]
async fn api_request(
    method: String,
    path: String,
    server_url: String,
    bearer: Option<String>,
    body: Option<serde_json::Value>,
) -> Result<ApiResponse, String> {
    let base = sanitize_url(&server_url)?;
    let path = path.trim();
    if path.is_empty() || !path.starts_with('/') {
        return Err("path must be a root-relative API path (e.g. /api/v1/status)".into());
    }
    if path.contains("://") || path.contains("..") {
        return Err("path must stay on the configured COSMOS host".into());
    }
    let method = method.trim().to_uppercase();
    if method != "GET" && method != "POST" {
        return Err("only GET and POST are allowed".into());
    }
    let url = format!("{base}{path}");

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(2))
        .user_agent("cDeck/0.1")
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let mut req = match method.as_str() {
        "POST" => client.post(&url),
        _ => client.get(&url),
    };
    req = req.header("Accept", "application/json");
    if let Some(tok) = bearer
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        req = req.header("Authorization", format!("Bearer {tok}"));
    }
    if let Some(body) = body {
        req = req.header("Content-Type", "application/json").json(&body);
    }

    let resp = req.send().await.map_err(|e| transport_err(&base, e))?;
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    let json = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text)
            .unwrap_or_else(|_| serde_json::json!({ "raw": text }))
    };
    Ok(ApiResponse { status, ok, json })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            api_request
        ])
        .run(tauri::generate_context!())
        .expect("cDeck failed to start");
}
