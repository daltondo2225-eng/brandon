// Bundled Node server lifecycle — the Rust analogue of electron/main/server.ts.
//
// Dev:  the developer runs `npm run dev:server` externally; we just read the
//       repo .env to learn its port + BRANDON_API_KEY and return that handle.
// Prod: we spawn the esbuild-bundled server (shipped under resources/server)
//       with Node, on a free loopback port, wait for /health, then read back
//       the API key the server writes to its data dir on first run.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

#[derive(Clone, serde::Serialize)]
pub struct ServerConfig {
    #[serde(rename = "serverBase")]
    pub server_base: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
}

/// Holds the spawned child (prod only) so we can kill it on shutdown.
#[derive(Default)]
pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub config: Mutex<Option<ServerConfig>>,
}

fn free_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Apply CREATE_NO_WINDOW on Windows so spawned console children (the server,
/// the captions sidecar) never flash a black console window — Brandon is meant
/// to be invisible during an interview. No-op on other platforms. This is the
/// Rust equivalent of Electron's `windowsHide: true`.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Walk up from the current working dir looking for the directory that holds
/// `server/data` (the Brandon repo root). Tries a few ancestors so it works
/// whether launched from src-tauri/, client-tauri/, or the repo root.
pub fn find_repo_root() -> Option<PathBuf> {
    let start = std::env::current_dir().ok()?;
    let mut dir = start.as_path();
    for _ in 0..6 {
        if dir.join("server").join("data").is_dir() || dir.join("server").join("src").is_dir() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
    None
}

/// Read BRANDON_API_KEY + PORT out of the repo .env for dev mode.
fn read_dev_env(repo_root: &PathBuf) -> (String, u16) {
    let mut api_key = String::new();
    let mut port: u16 = 8787;
    let env_path = repo_root.join(".env");
    if let Ok(contents) = std::fs::read_to_string(&env_path) {
        for line in contents.lines() {
            if let Some((k, v)) = line.split_once('=') {
                match k.trim() {
                    "BRANDON_API_KEY" => api_key = v.trim().to_string(),
                    "PORT" => {
                        if let Ok(p) = v.trim().parse::<u16>() {
                            port = p;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    (api_key, port)
}

/// Poll the loopback server's /health until it returns 200, using a native
/// TCP HTTP/1.1 GET — no dependency on a system `curl` (which isn't reliably
/// present or consistent on Windows). The server always binds 127.0.0.1.
fn wait_for_health(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut last_err = String::from("no attempt made");
    while Instant::now() < deadline {
        match probe_health_once(&addr) {
            Ok(true) => return Ok(()),
            Ok(false) => last_err = "non-200 status".into(),
            Err(e) => last_err = e,
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "Server did not become healthy at http://127.0.0.1:{port} within {timeout:?}: {last_err}"
    ))
}

fn probe_health_once(addr: &SocketAddr) -> Result<bool, String> {
    let mut stream = TcpStream::connect_timeout(addr, Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .ok();
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        addr.port()
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    // Status line looks like "HTTP/1.1 200 OK" — check the code token.
    let head = String::from_utf8_lossy(&buf[..n]);
    Ok(head.split_whitespace().nth(1) == Some("200"))
}

/// Start (or locate) the server and stash the resulting config in state.
pub fn start(app: &AppHandle) -> Result<ServerConfig, String> {
    let is_dev = cfg!(debug_assertions);

    if is_dev {
        // Find the repo root by walking up from the current dir until we hit one
        // that contains `server/data` — robust to whether we're launched from
        // src-tauri/ (cargo tauri dev) or client-tauri/ (running the binary).
        let repo_root = find_repo_root().ok_or_else(|| {
            "could not locate the repo's server/data dir (run from within the Brandon repo)".to_string()
        })?;
        let data_dir = repo_root.join("server").join("data");

        // The dev server (npm run dev:server) binds a free port and publishes
        // both the port and the API key to its data dir on startup. We poll for
        // those files so `npm run dev:tauri` works regardless of which process
        // wins the race — and so we never send a stale key/port (which would
        // 401 or hit the wrong server). See server/src/index.ts + config.ts.
        let port_file = data_dir.join("brandon-port");
        let key_file = data_dir.join("brandon-api-key");

        let deadline = Instant::now() + Duration::from_secs(20);
        let (port, api_key) = loop {
            let port = std::fs::read_to_string(&port_file)
                .ok()
                .and_then(|s| s.trim().parse::<u16>().ok());
            let key = std::fs::read_to_string(&key_file)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            // Prefer a real key from .env if the developer set one; otherwise
            // use the server-published key (mirrors ensureLocalApiKey()).
            let (env_key, _) = read_dev_env(&repo_root);
            let resolved_key = if !env_key.is_empty()
                && env_key != "change-me-to-a-random-string"
            {
                Some(env_key)
            } else {
                key
            };

            if let (Some(p), Some(k)) = (port, resolved_key) {
                break (p, k);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Dev server not detected. Run `npm run dev:server` (or `npm run dev:tauri`). \
                     Looked for {} and {}.",
                    port_file.display(),
                    key_file.display()
                ));
            }
            std::thread::sleep(Duration::from_millis(200));
        };

        let config = ServerConfig {
            server_base: format!("http://127.0.0.1:{port}"),
            api_key,
        };
        store_config(app, config.clone());
        return Ok(config);
    }

    // Production: spawn the bundled server.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("no resource dir: {e}"))?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let port = free_loopback_port().map_err(|e| e.to_string())?;
    let base_url = format!("http://127.0.0.1:{port}");

    // The server is shipped as a bundled server.mjs run by a bundled node
    // runtime (scripts/build-server-bundle.mjs --with-node), so the target
    // machine needs NO separately-installed Node. We prefer that bundled node,
    // and fall back to a `node` on PATH (dev machines / older layout) so neither
    // being present is fatal.
    let bin = resource_dir.join("bin");
    let node_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
    let bundled_node = bin.join(node_name);
    let server_mjs = bin.join("server.mjs");
    // Backward-compat with the older esbuild layout (resources/server/dist).
    let legacy_entry = resource_dir.join("server").join("dist").join("index.mjs");

    let mut cmd = if server_mjs.exists() {
        // Bundled runtime if present, else node on PATH — both run server.mjs.
        let mut c = Command::new(if bundled_node.exists() { bundled_node.clone() } else { node_name.into() });
        c.arg(&server_mjs).current_dir(&bin);
        c
    } else if legacy_entry.exists() {
        let mut c = Command::new("node");
        c.arg(&legacy_entry).current_dir(resource_dir.join("server"));
        c
    } else {
        return Err(format!(
            "No server found. Expected {} or {}. Run \
             `npm run build:server:tauri` before bundling.",
            server_mjs.display(),
            legacy_entry.display()
        ));
    };

    cmd.env("BRANDON_DATA_DIR", &data_dir)
        .env("PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn server: {e}"))?;

    // Drain stdout/stderr to a log so the pipes never fill and block the child.
    drain_to_log(child.stdout.take(), data_dir.join("server.log"), "out");
    drain_to_log(child.stderr.take(), data_dir.join("server.log"), "err");

    wait_for_health(port, Duration::from_secs(15))?;

    let key_file = data_dir.join("brandon-api-key");
    let api_key = std::fs::read_to_string(&key_file)
        .map_err(|_| format!("server started but no API key file at {}", key_file.display()))?
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err("server started but API key file is empty".into());
    }

    let config = ServerConfig {
        server_base: base_url,
        api_key,
    };
    {
        let state = app.state::<ServerState>();
        *state.child.lock().unwrap() = Some(child);
    }
    store_config(app, config.clone());
    Ok(config)
}

fn store_config(app: &AppHandle, config: ServerConfig) {
    let state = app.state::<ServerState>();
    *state.config.lock().unwrap() = Some(config);
}

fn drain_to_log(
    stream: Option<impl std::io::Read + Send + 'static>,
    log_path: PathBuf,
    tag: &'static str,
) {
    if let Some(stream) = stream {
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                {
                    use std::io::Write;
                    let _ = writeln!(f, "[{tag}] {line}");
                }
            }
        });
    }
}

/// Kill the spawned server on shutdown (prod only; no-op in dev).
pub fn stop(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }
}
