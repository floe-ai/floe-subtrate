mod fs_commands;
mod substrate_commands;

use serde::Serialize;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::{
  collections::VecDeque,
  io::{Read, Write},
  net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
  thread,
  time::Duration,
};
use tauri::{path::BaseDirectory, Emitter, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubstrateStatus {
  Healthy,
  NotRunning,
  Unresponsive,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubstrateHealthEvent {
  state: &'static str,
  detail: String,
  technical_detail: Option<String>,
}

fn emit_substrate_health(
  app: &tauri::AppHandle,
  state: &'static str,
  detail: impl Into<String>,
  technical_detail: Option<String>,
) {
  if let Err(error) = app.emit(
    "substrate-health",
    SubstrateHealthEvent {
      state,
      detail: detail.into(),
      technical_detail,
    },
  ) {
    log::warn!("could not publish substrate health: {error}");
  }
}

fn remember_stderr(tail: &mut VecDeque<String>, line: &[u8]) {
  let text = String::from_utf8_lossy(line).trim().to_string();
  if text.is_empty() {
    return;
  }
  if tail.len() == 8 {
    tail.pop_front();
  }
  tail.push_back(text.chars().take(500).collect());
}

fn is_healthy_http_response(response: &[u8]) -> bool {
  response.starts_with(b"HTTP/1.1 200") || response.starts_with(b"HTTP/1.0 200")
}

fn substrate_status() -> SubstrateStatus {
  let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 5377);
  let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
    return SubstrateStatus::NotRunning;
  };
  let timeout = Some(Duration::from_millis(500));
  if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
    return SubstrateStatus::Unresponsive;
  }
  if stream
    .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:5377\r\nConnection: close\r\n\r\n")
    .is_err()
  {
    return SubstrateStatus::Unresponsive;
  }
  let mut response = [0_u8; 256];
  match stream.read(&mut response) {
    Ok(read) if read > 0 && is_healthy_http_response(&response[..read]) => SubstrateStatus::Healthy,
    _ => SubstrateStatus::Unresponsive,
  }
}

#[cfg(target_os = "windows")]
fn stop_stale_packaged_substrate() -> bool {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x08000000;
  Command::new("taskkill")
    .args(["/IM", "floe-node.exe", "/T", "/F"])
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map(|status| status.success())
    .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn stop_stale_packaged_substrate() -> bool {
  false
}

fn wait_for_substrate_to_stop() -> bool {
  for _ in 0..20 {
    if substrate_status() == SubstrateStatus::NotRunning {
      return true;
    }
    thread::sleep(Duration::from_millis(50));
  }
  false
}

fn start_packaged_substrate(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  match substrate_status() {
    SubstrateStatus::Healthy => return Ok(()),
    SubstrateStatus::NotRunning => {}
    SubstrateStatus::Unresponsive => {
      log::warn!("unresponsive packaged substrate detected; attempting recovery");
      if !stop_stale_packaged_substrate() || !wait_for_substrate_to_stop() {
        return Err("port 5377 is occupied by an unresponsive service that Floe could not restart".into());
      }
    }
  }

  emit_substrate_health(app, "starting", "Starting Floe's local services.", None);
  let script = app.path().resolve("resources/floe-desktop.js", BaseDirectory::Resource)?;
  let script_dir = script.parent().ok_or("desktop resource has no parent directory")?;
  let (mut events, _child) = app
    .shell()
    .sidecar("floe-node")?
    .current_dir(script_dir)
    .arg("floe-desktop.js")
    .arg("substrate")
    .spawn()?;
  let health_app = app.clone();
  tauri::async_runtime::spawn(async move {
    let mut stderr_tail = VecDeque::new();
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(line) => log::info!("substrate: {}", String::from_utf8_lossy(&line)),
        CommandEvent::Stderr(line) => {
          remember_stderr(&mut stderr_tail, &line);
          log::warn!("substrate: {}", String::from_utf8_lossy(&line));
        }
        CommandEvent::Error(error) => {
          let detail = format!("The local service process failed: {error}");
          log::error!("substrate: {error}");
          emit_substrate_health(&health_app, "offline", detail, None);
        }
        CommandEvent::Terminated(status) => {
          let code = status
            .code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".into());
          let detail = format!("Floe's local services stopped unexpectedly (exit code {code}).");
          let technical_detail = if stderr_tail.is_empty() {
            None
          } else {
            Some(stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n"))
          };
          if status.code == Some(0) {
            log::info!("packaged substrate exited with status {:?}", status.code);
          } else {
            log::error!("packaged substrate exited with status {:?}", status.code);
          }
          emit_substrate_health(&health_app, "offline", detail, technical_detail);
        }
        _ => {}
      }
    }
  });
  Ok(())
}

#[tauri::command]
fn restart_packaged_substrate(app: tauri::AppHandle) -> Result<(), String> {
  start_packaged_substrate(&app).map_err(|error| {
    let detail = format!("Floe could not restart its local services: {error}");
    emit_substrate_health(&app, "offline", detail.clone(), None);
    detail
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .manage(substrate_commands::ProviderLoginProcess::default())
    .setup(|app| {
      if let Err(error) = start_packaged_substrate(app.handle()) {
        // Keep the window alive: the frontend has a bounded startup wait and
        // can explain the failure rather than disappearing without feedback.
        log::error!("could not start packaged substrate: {error}");
        emit_substrate_health(
          app.handle(),
          "offline",
          format!("Floe could not start its local services: {error}"),
          None,
        );
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      fs_commands::list_agent_files,
      fs_commands::read_file,
      fs_commands::read_media_file,
      fs_commands::write_file,
      fs_commands::stage_attachment,
      substrate_commands::get_substrate_auth_profiles,
      substrate_commands::save_substrate_auth_profile,
      substrate_commands::delete_substrate_auth_profile,
      substrate_commands::get_model_providers,
      substrate_commands::connect_model_provider,
      substrate_commands::get_runtime_adapter,
      substrate_commands::set_runtime_adapter,
      restart_packaged_substrate,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|handle, event| {
    if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
      handle.state::<substrate_commands::ProviderLoginProcess>().stop();
    }
  });
}

#[cfg(test)]
mod tests {
  use std::collections::VecDeque;

  use super::{is_healthy_http_response, remember_stderr};

  #[test]
  fn accepts_only_successful_http_health_responses() {
    assert!(is_healthy_http_response(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}"));
    assert!(!is_healthy_http_response(b"HTTP/1.1 503 Service Unavailable\r\n\r\n"));
    assert!(!is_healthy_http_response(b""));
  }

  #[test]
  fn keeps_a_bounded_stderr_tail_for_operator_diagnostics() {
    let mut tail = VecDeque::new();
    for index in 0..10 {
      remember_stderr(&mut tail, format!("failure {index}").as_bytes());
    }
    assert_eq!(tail.len(), 8);
    assert_eq!(tail.front().map(String::as_str), Some("failure 2"));
    assert_eq!(tail.back().map(String::as_str), Some("failure 9"));
  }
}
