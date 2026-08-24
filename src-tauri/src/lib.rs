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

/// Reduce the pasted server URL to a bare ORIGIN (scheme://host[:port]).
///
/// This is a real parse, not string-prefix checking: anything carrying a
/// path, query, or fragment is rejected, so `format!("{base}{path}")`
/// downstream cannot be diverted onto a different resource.
fn sanitize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("server URL is required".into());
    }
    if !(raw.starts_with("http://") || raw.starts_with("https://")) {
        return Err("server URL must start with http:// or https://".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid server URL: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("server URL must start with http:// or https://".into()),
    }
    // Refuse embedded credentials so a pasted `http://user:token@host` cannot
    // land on disk. The bearer field is the only place a secret may live, and
    // it is memory-only.
    if !url.username().is_empty() || url.password().is_some() {
        return Err("server URL must not contain credentials (user:pass@host)".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "server URL must include a host".to_string())?;
    if !matches!(url.path(), "" | "/") {
        return Err("server URL must be an origin only — remove the path".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("server URL must be an origin only — remove the query/fragment".into());
    }
    let mut origin = format!("{}://{host}", url.scheme());
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

fn sanitize_api_path(raw: &str) -> Result<String, String> {
    let path = raw.trim();
    if path.is_empty() || !path.starts_with('/') {
        return Err("path must be a root-relative API path (e.g. /api/v1/status)".into());
    }
    if !path.starts_with("/api/v1/") {
        return Err("only /api/v1/* is allowed".into());
    }
    if path.contains("://") || path.contains("..") || path.contains('\\') || path.contains('#') {
        return Err("path must stay on the configured COSMOS host".into());
    }
    Ok(path.to_string())
}

/// What `load_config` hands the UI: the config plus an optional non-fatal
/// warning (e.g. malformed config.json) so a silent reset never masquerades
/// as a clean load.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedConfig {
    server_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<LoadedConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(LoadedConfig {
            server_url: AppConfig::default().server_url,
            warning: None,
        });
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read config: {e}"))?;
    let (mut cfg, warning) = match serde_json::from_str::<AppConfig>(&raw) {
        Ok(c) => (c, None),
        Err(e) => (
            AppConfig::default(),
            Some(format!(
                "config.json is malformed ({e}) — using default server URL {DEFAULT_URL}; \
                 CONNECT will rewrite it"
            )),
        ),
    };
    if cfg.server_url.trim().is_empty() {
        cfg.server_url = DEFAULT_URL.to_string();
    }
    Ok(LoadedConfig {
        server_url: cfg.server_url,
        warning,
    })
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
    let path = sanitize_api_path(&path)?;
    let method = method.trim().to_uppercase();
    if method != "GET" && method != "POST" {
        return Err("only GET and POST are allowed".into());
    }
    let url = format!("{base}{path}");

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        // No automatic redirect following: a 3xx from the COSMOS host could
        // otherwise send the bearer to an arbitrary Location (SSRF). A 3xx is
        // surfaced to the UI as a plain non-ok status instead.
        .redirect(reqwest::redirect::Policy::none())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            api_request
        ])
        .run(tauri::generate_context!())
        .expect("cDeck failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_trailing_slash() {
        assert_eq!(
            sanitize_url("http://127.0.0.1:8791/").unwrap(),
            "http://127.0.0.1:8791"
        );
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_url("   ").is_err());
    }

    #[test]
    fn sanitize_rejects_credentials() {
        assert!(sanitize_url("http://user:token@host:8791").is_err());
    }

    #[test]
    fn sanitize_rejects_non_http() {
        assert!(sanitize_url("ftp://127.0.0.1:8791").is_err());
    }

    #[test]
    fn sanitize_rejects_path_query_fragment() {
        assert!(sanitize_url("http://127.0.0.1:8791/evil").is_err());
        assert!(sanitize_url("http://127.0.0.1:8791/api/v1").is_err());
        assert!(sanitize_url("http://127.0.0.1:8791/?x=1").is_err());
        assert!(sanitize_url("http://127.0.0.1:8791/#frag").is_err());
    }

    #[test]
    fn sanitize_normalizes_to_origin() {
        assert_eq!(
            sanitize_url("https://cosmos.example.com").unwrap(),
            "https://cosmos.example.com"
        );
        assert_eq!(
            sanitize_url("http://192.168.1.10:8791/").unwrap(),
            "http://192.168.1.10:8791"
        );
    }

    #[test]
    fn path_must_be_v1_api() {
        assert!(sanitize_api_path("/dash").is_err());
        assert!(sanitize_api_path("/api/v1/status").is_ok());
        assert!(sanitize_api_path("/api/v1/events?since_seq=4").is_ok());
        assert!(sanitize_api_path("/api/v1/makers?kind=AGENT").is_ok());
        assert!(sanitize_api_path("/api/v1/../secret").is_err());
    }
}
