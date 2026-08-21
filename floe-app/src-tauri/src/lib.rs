mod fs_commands;
mod substrate_commands;

use std::{net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream}, time::Duration};
use tauri::{path::BaseDirectory, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

fn substrate_is_running() -> bool {
  let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 5377);
  TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok()
}

fn start_packaged_substrate(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  if substrate_is_running() {
    return Ok(());
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
    .manage(substrate_commands::ProviderLoginProcess::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      start_packaged_substrate(app)?;
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
