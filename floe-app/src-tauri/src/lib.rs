mod fs_commands;
mod substrate_commands;

use std::{
  io::{Read, Write},
  net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
  thread,
  time::Duration,
};
#[cfg(target_os = "windows")]
use std::process::Command;
use tauri::{path::BaseDirectory, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubstrateStatus {
  Healthy,
  NotRunning,
  Unresponsive,
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

fn start_packaged_substrate(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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

  let script = app.path().resolve("resources/floe-desktop.js", BaseDirectory::Resource)?;
  let script_dir = script.parent().ok_or("desktop resource has no parent directory")?;
  let (mut events, _child) = app
    .shell()
    .sidecar("floe-node")?
    .current_dir(script_dir)
    .arg("floe-desktop.js")
    .arg("substrate")
    .spawn()?;
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(line) => log::info!("substrate: {}", String::from_utf8_lossy(&line)),
        CommandEvent::Stderr(line) => log::warn!("substrate: {}", String::from_utf8_lossy(&line)),
        CommandEvent::Error(error) => log::error!("substrate: {error}"),
        CommandEvent::Terminated(status) if status.code != Some(0) => {
          log::error!("packaged substrate exited with status {:?}", status.code);
        }
        _ => {}
      }
    }
  });
  Ok(())
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
      if let Err(error) = start_packaged_substrate(app) {
        // Keep the window alive: the frontend has a bounded startup wait and
        // can explain the failure rather than disappearing without feedback.
        log::error!("could not start packaged substrate: {error}");
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      fs_commands::list_agent_files,
      fs_commands::read_file,
      fs_commands::write_file,
      substrate_commands::get_substrate_auth_profiles,
      substrate_commands::save_substrate_auth_profile,
      substrate_commands::delete_substrate_auth_profile,
      substrate_commands::get_model_providers,
      substrate_commands::connect_model_provider,
      substrate_commands::get_runtime_adapter,
      substrate_commands::set_runtime_adapter,
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
  use super::is_healthy_http_response;

  #[test]
  fn accepts_only_successful_http_health_responses() {
    assert!(is_healthy_http_response(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}"));
    assert!(!is_healthy_http_response(b"HTTP/1.1 503 Service Unavailable\r\n\r\n"));
    assert!(!is_healthy_http_response(b""));
  }
}
