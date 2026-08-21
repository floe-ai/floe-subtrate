use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use tauri_plugin_shell::ShellExt;

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

const CODEX_PROVIDER_ID: &str = "openai-codex-app-server";
const CODEX_PROFILE_ID: &str = "chatgpt-codex";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexModelRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_default: bool,
    pub reasoning_efforts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexProviderStatus {
    pub provider: String,
    pub available: bool,
    pub connected: bool,
    pub account_type: Option<String>,
    pub plan_type: Option<String>,
    pub models: Vec<CodexModelRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

fn sync_codex_profile(status: &CodexProviderStatus, requested_model: Option<String>) -> Result<AuthProfileRecord, String> {
    if !status.connected {
        return Err("ChatGPT is not connected".to_string());
    }
    let auth_dir = get_floe_auth_dir()?;
    fs::create_dir_all(&auth_dir)
        .map_err(|e| format!("Failed to create Floe auth directory: {}", e))?;

    let selected_model = requested_model
        .filter(|value| status.models.iter().any(|model| model.id == *value))
        .or_else(|| status.models.iter().find(|model| model.is_default).map(|model| model.id.clone()))
        .or_else(|| status.models.first().map(|model| model.id.clone()));
    let profile = AuthProfileRecord {
        id: CODEX_PROFILE_ID.to_string(),
        provider: CODEX_PROVIDER_ID.to_string(),
        model: selected_model,
        label: Some("ChatGPT subscription".to_string()),
        created_at: None,
        updated_at: None,
    };

    let profiles_path = auth_dir.join("profiles.yaml");
    let mut profiles = read_profiles(&profiles_path)?;
    upsert_profile(&mut profiles, profile.clone());
    write_profiles(&profiles_path, &profiles)?;

    // The bus exposes model metadata but never Codex credentials. Codex owns its
    // account and refresh tokens; this local overlay only makes its current model
    // catalogue selectable through Floe's existing workspace binding surface.
    let models_path = auth_dir.join("models.json");
    let mut models_doc: serde_json::Value = if models_path.exists() {
        serde_json::from_str(&fs::read_to_string(&models_path)
            .map_err(|e| format!("Failed to read models.json: {}", e))?)
            .unwrap_or_else(|_| serde_json::json!({ "providers": {} }))
    } else {
        serde_json::json!({ "providers": {} })
    };
    if !models_doc.get("providers").is_some_and(|value| value.is_object()) {
        models_doc["providers"] = serde_json::json!({});
    }
    models_doc["providers"][CODEX_PROVIDER_ID] = serde_json::json!({
        "models": status.models.iter().map(|model| serde_json::json!({
            "id": model.id,
            "name": model.name,
            "api": "codex-app-server",
            "reasoning": !model.reasoning_efforts.is_empty(),
            "input": ["text", "image"]
        })).collect::<Vec<_>>()
    });
    fs::write(
        &models_path,
        format!("{}\n", serde_json::to_string_pretty(&models_doc)
            .map_err(|e| format!("Failed to serialize models.json: {}", e))?),
    ).map_err(|e| format!("Failed to write models.json: {}", e))?;
    Ok(profile)
}

async fn run_codex_helper(app: &tauri::AppHandle, command: &str) -> Result<CodexProviderStatus, String> {
    let output = app
        .shell()
        .sidecar("floe-auth")
        .map_err(|e| format!("Failed to prepare Codex: {}", e))?
        .arg(command)
        .output()
        .await
        .map_err(|e| format!("Failed to run Codex: {}", e))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { "Codex did not respond".to_string() } else { detail });
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "Codex returned invalid output".to_string())?;
    parse_codex_provider_status(&stdout)
}

fn parse_codex_provider_status(stdout: &str) -> Result<CodexProviderStatus, String> {
    // Opening the provider-owned browser flow can add blank or launcher output
    // after the helper's structured result on Windows. Treat stdout as a framed
    // stream and select the last valid provider-status record rather than the
    // last physical line.
    for line in stdout.lines().rev().map(str::trim).filter(|line| !line.is_empty()) {
        if let Ok(status) = serde_json::from_str::<CodexProviderStatus>(line) {
            if status.provider == CODEX_PROVIDER_ID {
                return Ok(status);
            }
        }
    }
    Err(if stdout.trim().is_empty() {
        "Codex returned no status".to_string()
    } else {
        "Codex returned output without a provider status".to_string()
    })
}

#[tauri::command]
pub async fn get_codex_provider_status(app: tauri::AppHandle) -> Result<CodexProviderStatus, String> {
    run_codex_helper(&app, "status").await
}

#[tauri::command]
pub async fn connect_codex_provider(
    app: tauri::AppHandle,
    model: Option<String>,
) -> Result<CodexProviderStatus, String> {
    let status = run_codex_helper(&app, "login").await?;
    sync_codex_profile(&status, model)?;
    Ok(status)
}

#[tauri::command]
pub async fn login_substrate_oauth(
    app: tauri::AppHandle,
    provider: String,
    profile_id: String,
    model: Option<String>,
) -> Result<AuthProfileRecord, String> {
    if provider != "openai-codex" && provider != CODEX_PROVIDER_ID {
        return Err(format!("Unsupported desktop OAuth provider: {}", provider));
    }
    if profile_id.trim().is_empty() {
        return Err("Profile ID is required".to_string());
    }
    let status = run_codex_helper(&app, "login").await?;
    sync_codex_profile(&status, model)
}

// ---------------------------------------------------------------------------
// Runtime adapter — Test (fake) / Live (provider router) switch
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
/// Valid values: "fake" (Test) or "floe-runtime" (Live provider router).
/// Legacy Pi values remain accepted for existing developer configurations.
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
            "Invalid adapter \"{}\". Use \"fake\" (Test) or \"floe-runtime\" (Live).",
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

    fn codex_status_json() -> String {
        serde_json::json!({
            "type": "provider_status",
            "provider": CODEX_PROVIDER_ID,
            "available": true,
            "connected": true,
            "account_type": "chatgpt",
            "plan_type": "business",
            "models": []
        }).to_string()
    }

    #[test]
    fn parses_codex_status_before_trailing_blank_or_launcher_output() {
        let json = codex_status_json();
        let status = parse_codex_provider_status(&format!("startup note\n{}\n\n", json)).unwrap();
        assert!(status.connected);

        let status = parse_codex_provider_status(&format!("{}\nlauncher finished\n", json)).unwrap();
        assert_eq!(status.plan_type.as_deref(), Some("business"));
    }

    #[test]
    fn rejects_empty_or_unrelated_codex_helper_output_without_json_parser_noise() {
        assert_eq!(parse_codex_provider_status("\r\n").unwrap_err(), "Codex returned no status");
        assert_eq!(
            parse_codex_provider_status("browser launcher output\n").unwrap_err(),
            "Codex returned output without a provider status"
        );
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
