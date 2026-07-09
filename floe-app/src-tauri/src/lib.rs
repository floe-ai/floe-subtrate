mod fs_commands;
mod substrate_commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
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
      substrate_commands::get_runtime_adapter,
      substrate_commands::set_runtime_adapter,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
