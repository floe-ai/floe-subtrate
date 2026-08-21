use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;
use tauri::{path::BaseDirectory, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

static PROVIDER_LOGIN_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ProviderLoginGuard;

impl ProviderLoginGuard {
    fn acquire() -> Result<Self, String> {
        PROVIDER_LOGIN_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "A provider sign-in is already in progress".to_string())
    }
}

impl Drop for ProviderLoginGuard {
    fn drop(&mut self) {
        PROVIDER_LOGIN_ACTIVE.store(false, Ordering::Release);
    }
}

struct ProviderLoginChild(Option<CommandChild>);

impl Drop for ProviderLoginChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthProfileRecord {
    pub id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfilesDocument {
    pub version: u32,
    pub profiles: Vec<AuthProfileRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfilesResponse {
    pub profiles: Vec<AuthProfileRecord>,
    pub default_auth_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStorageItem {
    pub r#type: String, // "api_key" or "oauth"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProviderModel {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub reasoning_efforts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProviderStatus {
    pub r#type: String,
    pub provider: String,
    pub name: String,
    pub auth_name: String,
    pub connected: bool,
    pub profile_id: String,
    pub models: Vec<ModelProviderModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProvidersResponse {
    pub r#type: String,
    pub providers: Vec<ModelProviderStatus>,
}

fn get_floe_auth_dir() -> Result<PathBuf, String> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "Could not determine user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".floe").join("auth"))
}

fn read_profiles(path: &PathBuf) -> Result<ProfilesDocument, String> {
    if !path.exists() {
        return Ok(ProfilesDocument {
            version: 1,
            profiles: Vec::new(),
        });
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read profiles.yaml: {}", e))?;
    if content.trim().is_empty() {
        return Ok(ProfilesDocument {
            version: 1,
            profiles: Vec::new(),
        });
    }
    serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse profiles.yaml: {}", e))
}

fn write_profiles(path: &PathBuf, doc: &ProfilesDocument) -> Result<(), String> {
    let updated = serde_yaml::to_string(doc)
        .map_err(|e| format!("Failed to serialize profiles.yaml: {}", e))?;
    fs::write(path, updated).map_err(|e| format!("Failed to write profiles.yaml: {}", e))
}

fn upsert_profile(doc: &mut ProfilesDocument, profile: AuthProfileRecord) {
    if let Some(existing) = doc.profiles.iter_mut().find(|item| item.id == profile.id) {
        *existing = profile;
    } else {
        doc.profiles.push(profile);
        doc.profiles.sort_by(|a, b| a.id.cmp(&b.id));
    }
}

fn read_auth_storage(path: &PathBuf) -> Result<HashMap<String, AuthStorageItem>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read auth.json: {}", e))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse auth.json: {}", e))
}

fn write_auth_storage(
    path: &PathBuf,
    data: &HashMap<String, AuthStorageItem>,
) -> Result<(), String> {
    let updated = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize auth.json: {}", e))?;
    fs::write(path, format!("{}\n", updated))
        .map_err(|e| format!("Failed to write auth.json: {}", e))
}

fn get_floe_config_path() -> Result<PathBuf, String> {
    // Honour FLOE_CONFIG env override (same logic as the TS bridge)
    if let Ok(explicit) = env::var("FLOE_CONFIG") {
        return Ok(PathBuf::from(explicit));
    }
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "Could not determine user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".floe").join("config.yaml"))
}

/// Read config.yaml, update bridge.runtime_adapter, write back.
/// Uses serde_yaml::Value so the rest of the file is not disturbed.
fn write_runtime_adapter_to_config(adapter: &str) -> Result<(), String> {
    let config_path = get_floe_config_path()?;
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse config.yaml: {}", e))?;
    // Navigate bridge section, creating it if missing
    let bridge = doc
        .get_mut("bridge")
        .ok_or_else(|| "config.yaml missing 'bridge' section".to_string())?;
    let bridge_map = bridge
        .as_mapping_mut()
        .ok_or_else(|| "config.yaml 'bridge' is not a mapping".to_string())?;
    bridge_map.insert(
        serde_yaml::Value::String("runtime_adapter".to_string()),
        serde_yaml::Value::String(adapter.to_string()),
    );
    let updated = serde_yaml::to_string(&doc)
        .map_err(|e| format!("Failed to serialize config.yaml: {}", e))?;
    fs::write(&config_path, updated).map_err(|e| format!("Failed to write config.yaml: {}", e))?;
    Ok(())
}

fn read_runtime_adapter_from_config() -> Result<Option<String>, String> {
    let config_path = get_floe_config_path()?;
    if !config_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;
    let doc: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse config.yaml: {}", e))?;
    let adapter = doc
        .get("bridge")
        .and_then(|b| b.get("runtime_adapter"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(adapter)
}

#[tauri::command]
pub fn get_substrate_auth_profiles() -> Result<ProfilesResponse, String> {
    let auth_dir = get_floe_auth_dir()?;
    let profiles_yaml_path = auth_dir.join("profiles.yaml");

    let mut profiles = Vec::new();
    if profiles_yaml_path.exists() {
        let content = fs::read_to_string(&profiles_yaml_path)
            .map_err(|e| format!("Failed to read profiles.yaml: {}", e))?;
        if !content.trim().is_empty() {
            let doc: ProfilesDocument = serde_yaml::from_str(&content)
                .map_err(|e| format!("Failed to parse profiles.yaml: {}", e))?;
            profiles = doc.profiles;
        }
    }

    Ok(ProfilesResponse {
        profiles,
        default_auth_profile: None,
    })
}

fn save_profile_to_dir(
    auth_dir: &PathBuf,
    profile: AuthProfileRecord,
    api_key: Option<String>,
) -> Result<(), String> {
    fs::create_dir_all(auth_dir).map_err(|e| format!("Failed to create auth directory: {}", e))?;

    let profiles_yaml_path = auth_dir.join("profiles.yaml");
    let auth_json_path = auth_dir.join("auth.json");

    let mut doc = read_profiles(&profiles_yaml_path)?;
    upsert_profile(&mut doc, profile.clone());
    write_profiles(&profiles_yaml_path, &doc)?;

    // 2. Update auth.json securely if key is specified
    if let Some(key) = api_key {
        let mut auth_data = read_auth_storage(&auth_json_path)?;

        if key.is_empty() {
            auth_data.remove(&profile.provider);
        } else {
            auth_data.insert(
                profile.provider.clone(),
                AuthStorageItem {
                    r#type: "api_key".to_string(),
                    key: Some(key),
                    extra: HashMap::new(),
                },
            );
        }
        write_auth_storage(&auth_json_path, &auth_data)?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_substrate_auth_profile(
    profile: AuthProfileRecord,
    api_key: Option<String>,
) -> Result<(), String> {
    save_profile_to_dir(&get_floe_auth_dir()?, profile, api_key)
}

#[tauri::command]
pub fn delete_substrate_auth_profile(profile_id: String) -> Result<(), String> {
    let auth_dir = get_floe_auth_dir()?;
    let profiles_yaml_path = auth_dir.join("profiles.yaml");
    let auth_json_path = auth_dir.join("auth.json");

    let mut removed_provider: Option<String> = None;
    let mut profile_id_is_active_provider = false;
    if profiles_yaml_path.exists() {
        let mut doc = read_profiles(&profiles_yaml_path)?;
        removed_provider = doc
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .map(|profile| profile.provider.clone());
        doc.profiles.retain(|profile| profile.id != profile_id);
        profile_id_is_active_provider = doc
            .profiles
            .iter()
            .any(|profile| profile.provider == profile_id);
        write_profiles(&profiles_yaml_path, &doc)?;
        if let Some(provider) = &removed_provider {
            if doc
                .profiles
                .iter()
                .any(|profile| &profile.provider == provider)
            {
                removed_provider = None;
            }
        }
    }

    if auth_json_path.exists() {
        let mut auth_data = read_auth_storage(&auth_json_path)?;
        if !profile_id_is_active_provider {
            auth_data.remove(&profile_id); // clean up credentials written by the older desktop format
        }
        if let Some(provider) = removed_provider {
            auth_data.remove(&provider);
        }
        write_auth_storage(&auth_json_path, &auth_data)?;
    }

    Ok(())
}

fn parse_model_providers(stdout: &str) -> Result<Vec<ModelProviderStatus>, String> {
    for line in stdout.lines().rev().map(str::trim).filter(|line| !line.is_empty()) {
        if let Ok(response) = serde_json::from_str::<ModelProvidersResponse>(line) {
            if response.r#type == "provider_statuses" {
                return Ok(response.providers);
            }
        }
    }
    Err(if stdout.trim().is_empty() {
        "The provider helper returned no status".to_string()
    } else {
        "The provider helper returned invalid status".to_string()
    })
}

#[tauri::command]
pub async fn get_model_providers(app: tauri::AppHandle) -> Result<Vec<ModelProviderStatus>, String> {
    let auth_dir = get_floe_auth_dir()?;
    let script = app.path().resolve("resources/floe-desktop.js", BaseDirectory::Resource)
        .map_err(|e| format!("Failed to locate provider setup: {}", e))?;
    let script_dir = script.parent()
        .ok_or_else(|| "The provider setup resource has no parent directory".to_string())?;
    let output = app
        .shell()
        .sidecar("floe-node")
        .map_err(|e| format!("Failed to prepare provider setup: {}", e))?
        .current_dir(script_dir)
        .args(["floe-desktop.js".as_ref(), "auth".as_ref(), "providers".as_ref(), auth_dir.as_os_str()])
        .output()
        .await
        .map_err(|e| format!("Failed to inspect model providers: {}", e))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { "The provider helper did not respond".to_string() } else { detail });
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "The provider helper returned invalid output".to_string())?;
    parse_model_providers(&stdout)
}

#[tauri::command]
pub async fn connect_model_provider(
    app: tauri::AppHandle,
    provider: String,
    on_event: Channel<serde_json::Value>,
) -> Result<ModelProviderStatus, String> {
    let _login_guard = ProviderLoginGuard::acquire()?;
    let auth_dir = get_floe_auth_dir()?;
    let script = app.path().resolve("resources/floe-desktop.js", BaseDirectory::Resource)
        .map_err(|e| format!("Failed to locate provider setup: {}", e))?;
    let script_dir = script.parent()
        .ok_or_else(|| "The provider setup resource has no parent directory".to_string())?;
    let (mut receiver, child) = app
        .shell()
        .sidecar("floe-node")
        .map_err(|e| format!("Failed to prepare provider setup: {}", e))?
        .current_dir(script_dir)
        .args([
            "floe-desktop.js".as_ref(),
            "auth".as_ref(),
            "login".as_ref(),
            auth_dir.as_os_str(),
            provider.as_ref(),
        ])
        .spawn()
        .map_err(|e| format!("Failed to start provider sign-in: {}", e))?;
    let _child_guard = ProviderLoginChild(Some(child));

    let mut stderr = String::new();
    let mut result: Option<ModelProviderStatus> = None;
    let mut exit_code: Option<i32> = None;
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
                if value.get("type").and_then(|item| item.as_str()) == Some("provider_status") {
                    result = serde_json::from_value(value)
                        .map_err(|e| format!("The provider helper returned invalid account status: {}", e))?;
                } else {
                    on_event.send(value).map_err(|e| format!("Could not update the sign-in screen: {}", e))?;
                }
            }
            CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Error(error) => return Err(error),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }

    if exit_code != Some(0) {
        let detail = stderr.trim();
        return Err(if detail.is_empty() { "Provider sign-in did not complete".to_string() } else { detail.to_string() });
    }
    let status = result.ok_or_else(|| "Provider sign-in completed without account status".to_string())?;
    write_runtime_adapter_to_config("pi-agent-core")?;
    Ok(status)
}

// ---------------------------------------------------------------------------
// Runtime adapter — Test (fake) / Live (Pi) switch
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeAdapterStatus {
    /// The persisted setting in config.yaml bridge.runtime_adapter (None = auto-detect)
    pub configured_adapter: Option<String>,
}

/// Read the persisted runtime_adapter from ~/.floe/config.yaml.
#[tauri::command]
pub fn get_runtime_adapter() -> Result<RuntimeAdapterStatus, String> {
    let configured_adapter = read_runtime_adapter_from_config()?;
    Ok(RuntimeAdapterStatus { configured_adapter })
}

/// Persist runtime_adapter to ~/.floe/config.yaml bridge.runtime_adapter.
/// Valid values: "fake" (Test) or "pi-agent-core" (Live).
/// The former "floe-runtime" name remains an alias for existing local configurations.
/// The new value takes effect on the next bridge start.
#[tauri::command]
pub fn set_runtime_adapter(adapter: String) -> Result<(), String> {
    let normalised = adapter.trim().to_lowercase();
    if normalised != "fake"
        && normalised != "floe-runtime"
        && normalised != "pi"
        && normalised != "pi-agent-core"
    {
        return Err(format!(
            "Invalid adapter \"{}\". Use \"fake\" (Test) or \"pi-agent-core\" (Live).",
            adapter
        ));
    }
    write_runtime_adapter_to_config(&normalised)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "floe-auth-{}-{}-{}",
            name,
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn profile(id: &str, provider: &str) -> AuthProfileRecord {
        AuthProfileRecord {
            id: id.to_string(),
            provider: provider.to_string(),
            model: None,
            label: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn providers_status_json() -> String {
        serde_json::json!({
            "type": "provider_statuses",
            "providers": [{
                "type": "provider_status",
                "provider": "openai-codex",
                "name": "ChatGPT",
                "auth_name": "OpenAI (ChatGPT Plus/Pro)",
                "connected": true,
                "profile_id": "openai-codex-subscription",
                "models": []
            }]
        }).to_string()
    }

    #[test]
    fn parses_provider_statuses_before_trailing_blank_or_launcher_output() {
        let json = providers_status_json();
        let providers = parse_model_providers(&format!("startup note\n{}\n\n", json)).unwrap();
        assert!(providers[0].connected);

        let providers = parse_model_providers(&format!("{}\nlauncher finished\n", json)).unwrap();
        assert_eq!(providers[0].provider, "openai-codex");
    }

    #[test]
    fn rejects_empty_or_unrelated_provider_helper_output_without_json_parser_noise() {
        assert_eq!(parse_model_providers("\r\n").unwrap_err(), "The provider helper returned no status");
        assert_eq!(
            parse_model_providers("browser launcher output\n").unwrap_err(),
            "The provider helper returned invalid status"
        );
    }

    #[test]
    fn permits_only_one_provider_login_at_a_time() {
        let first = ProviderLoginGuard::acquire().unwrap();
        assert_eq!(
            ProviderLoginGuard::acquire().err().as_deref(),
            Some("A provider sign-in is already in progress")
        );
        drop(first);
        assert!(ProviderLoginGuard::acquire().is_ok());
    }

    #[test]
    fn api_key_is_stored_by_provider_not_profile_id() {
        let dir = temp_dir("provider-key");
        save_profile_to_dir(
            &dir,
            profile("openai-personal", "openai"),
            Some("secret".to_string()),
        )
        .unwrap();

        let auth = read_auth_storage(&dir.join("auth.json")).unwrap();
        assert_eq!(
            auth.get("openai").and_then(|item| item.key.as_deref()),
            Some("secret")
        );
        assert!(!auth.contains_key("openai-personal"));

        fs::remove_dir_all(dir).unwrap();
    }

}
