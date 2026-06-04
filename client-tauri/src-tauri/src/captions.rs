// Captions sidecar lifecycle — the Rust analogue of electron/main/captions.ts.
//
// Spawns the .NET BrandonCaptions sidecar (Windows-only; reads Live Captions via
// UI Automation), parses its NDJSON stdout one line at a time, and re-emits each
// line verbatim as a `captions` Tauri event so OverlayApp.tsx receives the exact
// same payloads it always did. Restarts the sidecar 2s after an unexpected exit.
//
// On macOS the sidecar binary won't exist; we emit `sidecar-missing` once and
// stay quiet, exactly like the Electron version — the overlay shows "sidecar
// missing" and everything else (chat, profiles) works for dev.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

const CAPTIONS_EVENT: &str = "captions";

fn sidecar_path(app: &AppHandle) -> PathBuf {
    let exe = if cfg!(target_os = "windows") {
        "BrandonCaptions.exe"
    } else {
        // No macOS sidecar exists yet; this path is reported in sidecar-missing.
        "BrandonCaptions"
    };
    if cfg!(debug_assertions) {
        // repo root -> client/resources/bin (robust to launch cwd).
        crate::server::find_repo_root()
            .unwrap_or_default()
            .join("client")
            .join("resources")
            .join("bin")
            .join(exe)
    } else {
        app.path()
            .resource_dir()
            .map(|d| d.join("bin").join(exe))
            .unwrap_or_else(|_| PathBuf::from(exe))
    }
}

fn emit(app: &AppHandle, payload: Value) {
    // Target the overlay window specifically — that's the only consumer.
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit(CAPTIONS_EVENT, payload);
    }
}

/// Spawn the sidecar and pump events. Runs on a background thread that owns the
/// child for its lifetime; on exit it sleeps 2s and re-spawns (unless we're
/// shutting down, in which case the AppHandle's run loop has already ended).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let exe = sidecar_path(&app);
        if !exe.exists() {
            emit(
                &app,
                serde_json::json!({
                    "type": "sidecar-missing",
                    "expectedPath": exe.display().to_string(),
                }),
            );
            return; // No point retrying a missing binary.
        }

        let mut cmd = Command::new(&exe);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::server::hide_console(&mut cmd); // no console flash on Windows
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit(
                    &app,
                    serde_json::json!({
                        "type": "error",
                        "message": format!("Failed to spawn captions sidecar: {e}"),
                    }),
                );
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(v) => emit(&app, v),
                    Err(_) => emit(
                        &app,
                        serde_json::json!({
                            "type": "error",
                            "message": format!("Bad JSON from sidecar: {}",
                                &line.chars().take(200).collect::<String>()),
                        }),
                    ),
                }
            }
        }

        let _ = child.wait();
        emit(
            &app,
            serde_json::json!({
                "type": "error",
                "message": "Captions sidecar exited; restarting in 2s",
            }),
        );
        std::thread::sleep(Duration::from_secs(2));
    });
}
