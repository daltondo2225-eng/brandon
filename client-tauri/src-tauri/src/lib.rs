// Brandon — Tauri shell. Reproduces the behavior of the old Electron main
// process (client/electron/main/index.ts): two windows, global hotkeys, a tray,
// a screen-share-invisible always-on-top overlay, and the spawned Node server +
// .NET captions sidecar. The React UI talks to all of it through the same
// command/event names the old preload bridge used, so the renderer is unchanged.

mod captions;
mod server;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use server::{ServerConfig, ServerState};

/// Saved expanded overlay bounds, captured when collapsing so we can restore
/// pixel-perfectly (mirrors the savedExpandedBounds logic in the Electron main).
#[derive(Default)]
struct OverlayBounds(Mutex<Option<(i32, i32, u32, u32)>>);

#[derive(Serialize, Clone)]
struct HotkeyPayload<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
}

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Re-assert the overlay's stealth + on-top properties. Some platforms drop
/// always-on-top / content-protection on show/focus, so we reapply then.
fn reapply_overlay_flags(win: &WebviewWindow) {
    let _ = win.set_always_on_top(true);
    let _ = win.set_content_protected(true);
    let _ = win.set_visible_on_all_workspaces(true);
}

/* ------------------------- Tauri commands ---------------------------- */
/* Names match the invoke() calls in src/lib/bridge.ts exactly.          */

#[tauri::command]
fn get_config(state: tauri::State<ServerState>) -> Result<ServerConfig, String> {
    let guard = state.config.lock().unwrap();
    guard
        .clone()
        .ok_or_else(|| "server config not ready".into())
}

#[tauri::command]
fn overlay_set_mouse_passthrough(app: AppHandle, passthrough: bool) {
    if let Some(win) = overlay(&app) {
        let _ = win.set_ignore_cursor_events(passthrough);
    }
}

#[tauri::command]
fn overlay_focus(app: AppHandle) {
    if let Some(win) = overlay(&app) {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn overlay_set_size(app: AppHandle, width: f64, height: f64) {
    if let Some(win) = overlay(&app) {
        let w = width.round().max(540.0);
        let h = height.round().clamp(120.0, 900.0);
        let _ = win.set_size(LogicalSize::new(w, h));
    }
}

#[tauri::command]
fn overlay_set_collapsed(app: AppHandle, collapsed: bool) {
    let Some(win) = overlay(&app) else { return };
    let saved = app.state::<OverlayBounds>();
    if collapsed {
        // Capture current physical bounds, then shrink to a centered pill.
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
            *saved.0.lock().unwrap() = Some((pos.x, pos.y, size.width, size.height));
            let scale = win.scale_factor().unwrap_or(1.0);
            let pill_w = 260.0;
            let pill_h = 56.0;
            let cur_w_logical = size.width as f64 / scale;
            let new_x = pos.x as f64 / scale + (cur_w_logical - pill_w) / 2.0;
            let new_y = pos.y as f64 / scale;
            let _ = win.set_size(LogicalSize::new(pill_w, pill_h));
            let _ = win.set_position(LogicalPosition::new(new_x, new_y));
        }
    } else if let Some((x, y, w, h)) = saved.0.lock().unwrap().take() {
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(PhysicalSize::new(w, h));
    }
}

#[tauri::command]
fn overlay_hide(app: AppHandle) {
    if let Some(win) = overlay(&app) {
        let _ = win.hide();
    }
}

#[tauri::command]
fn overlay_show(app: AppHandle) {
    if let Some(win) = overlay(&app) {
        let _ = win.show();
        reapply_overlay_flags(&win);
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn main_show(app: AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // Tell the renderer to refresh so a just-ended meeting appears.
        let _ = win.emit("main:refresh", serde_json::json!({ "reason": "shown" }));
    }
}

#[tauri::command]
fn main_hide(app: AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.hide();
    }
}

#[tauri::command]
fn settings_set_detectable(app: AppHandle, detectable: bool) {
    if let Some(win) = overlay(&app) {
        // detectable == visible in screen capture, so protection is the inverse.
        let _ = win.set_content_protected(!detectable);
    }
}

/* ----------------------------- Tray ---------------------------------- */

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_main = MenuItem::with_id(app, "show_main", "Show Brandon", true, None::<&str>)?;
    let toggle_overlay =
        MenuItem::with_id(app, "toggle_overlay", "Show / hide overlay", true, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear_transcript", "Clear transcript", true, None::<&str>)?;
    let assist = MenuItem::with_id(app, "trigger_assist", "Trigger Assist", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Brandon", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_main, &toggle_overlay, &sep, &clear, &assist, &sep, &quit],
    )?;

    TrayIconBuilder::with_id("brandon-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Brandon — live interview assistant")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_main" => main_show(app.clone()),
            "toggle_overlay" => toggle_overlay_visibility(app),
            "clear_transcript" => emit_hotkey(app, "clear-transcript"),
            "trigger_assist" => emit_hotkey(app, "trigger-chat"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click the tray icon → bring the main window forward.
            if let TrayIconEvent::Click { .. } = event {
                main_show(tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

fn toggle_overlay_visibility(app: &AppHandle) {
    if let Some(win) = overlay(app) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            reapply_overlay_flags(&win);
        }
    }
}

fn emit_hotkey(app: &AppHandle, kind: &str) {
    if let Some(win) = overlay(app) {
        let _ = win.emit("hotkey", HotkeyPayload { kind });
    }
}

/// The three global accelerators, with CmdOrCtrl semantics (SUPER on macOS,
/// CONTROL elsewhere) matching the old Electron "CommandOrControl+..." set.
/// Built fresh wherever needed so no closure has to borrow shared locals.
fn shortcuts() -> (Shortcut, Shortcut, Shortcut) {
    let mods = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    (
        Shortcut::new(Some(mods), Code::Enter),          // trigger Assist
        Shortcut::new(Some(mods), Code::Backquote),      // toggle overlay
        Shortcut::new(Some(mods | Modifiers::SHIFT), Code::Backquote), // clear transcript
    )
}

/* ------------------------- App entry point --------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .manage(OverlayBounds::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let (sc_assist, sc_toggle, sc_clear) = shortcuts();
                    if shortcut == &sc_assist {
                        emit_hotkey(app, "trigger-chat");
                        if let Some(win) = overlay(app) {
                            if !win.is_visible().unwrap_or(false) {
                                let _ = win.show();
                                reapply_overlay_flags(&win);
                            }
                        }
                    } else if shortcut == &sc_toggle {
                        toggle_overlay_visibility(app);
                    } else if shortcut == &sc_clear {
                        emit_hotkey(app, "clear-transcript");
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_config,
            overlay_set_mouse_passthrough,
            overlay_focus,
            overlay_set_size,
            overlay_set_collapsed,
            overlay_hide,
            overlay_show,
            main_show,
            main_hide,
            settings_set_detectable,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 1. Start (or locate) the bundled server before anything else.
            if let Err(e) = server::start(&handle) {
                // Surface the failure and bail, like the Electron error dialog.
                if let Some(win) = main_window(&handle) {
                    let _ = win.emit("server:fatal", e.clone());
                }
                eprintln!("Brandon: server failed to start: {e}");
            }

            // 2. Overlay starts hidden; stamp its stealth flags up front.
            if let Some(win) = overlay(&handle) {
                reapply_overlay_flags(&win);
                // Float above full-screen apps (Zoom/Meet share). Tauri maps
                // always-on-top to the screen-saver NSWindow level on macOS.
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        reapply_overlay_flags(&win2);
                    }
                });
            }

            // 3. Register global hotkeys.
            let (sc_assist, sc_toggle, sc_clear) = shortcuts();
            for sc in [sc_assist, sc_toggle, sc_clear] {
                let _ = app.global_shortcut().register(sc);
            }

            // 4. Tray.
            build_tray(&handle)?;

            // 5. Captions sidecar (spawns a background pump thread).
            captions::start(handle.clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it (tray keeps the app alive),
            // mirroring the Electron close→hide behavior.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Brandon")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                server::stop(app);
            }
        });
}
