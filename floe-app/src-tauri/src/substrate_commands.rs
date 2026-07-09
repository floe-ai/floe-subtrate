use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::env;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthProfileRecord {
    pub id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
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
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

fn get_floe_auth_dir() -> Result<PathBuf, String> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "Could not determine user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".floe").join("auth"))
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
    fs::write(&config_path, updated)
        .map_err(|e| format!("Failed to write config.yaml: {}", e))?;
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

#[tauri::command]
pub fn save_substrate_auth_profile(
    profile: AuthProfileRecord,
    api_key: Option<String>,
) -> Result<(), String> {
    let auth_dir = get_floe_auth_dir()?;
    fs::create_dir_all(&auth_dir)
        .map_err(|e| format!("Failed to create auth directory: {}", e))?;
        
    let profiles_yaml_path = auth_dir.join("profiles.yaml");
    let auth_json_path = auth_dir.join("auth.json");
    
    // 1. Update profiles.yaml
    let mut doc = if profiles_yaml_path.exists() {
        let content = fs::read_to_string(&profiles_yaml_path)
            .map_err(|e| format!("Failed to read profiles.yaml: {}", e))?;
        if content.trim().is_empty() {
            ProfilesDocument { version: 1, profiles: Vec::new() }
        } else {
            serde_yaml::from_str(&content)
                .map_err(|e| format!("Failed to parse profiles.yaml: {}", e))?
        }
    } else {
        ProfilesDocument { version: 1, profiles: Vec::new() }
    };
    
    let existing_idx = doc.profiles.iter().position(|p| p.id == profile.id);
    if let Some(idx) = existing_idx {
        doc.profiles[idx] = profile.clone();
    } else {
        doc.profiles.push(profile.clone());
    }
    
    let updated_yaml = serde_yaml::to_string(&doc)
        .map_err(|e| format!("Failed to serialize profiles.yaml: {}", e))?;
    fs::write(&profiles_yaml_path, updated_yaml)
        .map_err(|e| format!("Failed to write profiles.yaml: {}", e))?;
        
    // 2. Update auth.json securely if key is specified
    if let Some(key) = api_key {
        let mut auth_data: std::collections::HashMap<String, AuthStorageItem> = if auth_json_path.exists() {
            let content = fs::read_to_string(&auth_json_path)
                .map_err(|e| format!("Failed to read auth.json: {}", e))?;
            if content.trim().is_empty() {
                std::collections::HashMap::new()
            } else {
                serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse auth.json: {}", e))?
            }
        } else {
            std::collections::HashMap::new()
        };
        
        if key.is_empty() {
            auth_data.remove(&profile.id);
        } else {
            auth_data.insert(profile.id.clone(), AuthStorageItem {
                r#type: "api_key".to_string(),
                key: Some(key),
                extra: std::collections::HashMap::new(),
            });
        }
        
        let updated_json = serde_json::to_string_pretty(&auth_data)
            .map_err(|e| format!("Failed to serialize auth.json: {}", e))?;
        fs::write(&auth_json_path, updated_json)
            .map_err(|e| format!("Failed to write auth.json: {}", e))?;
    }
    
    Ok(())
}

#[tauri::command]
pub fn delete_substrate_auth_profile(profile_id: String) -> Result<(), String> {
    let auth_dir = get_floe_auth_dir()?;
    let profiles_yaml_path = auth_dir.join("profiles.yaml");
    let auth_json_path = auth_dir.join("auth.json");
    
    // 1. Remove from profiles.yaml
    if profiles_yaml_path.exists() {
        let content = fs::read_to_string(&profiles_yaml_path)
            .map_err(|e| format!("Failed to read profiles.yaml: {}", e))?;
        if !content.trim().is_empty() {
            let mut doc: ProfilesDocument = serde_yaml::from_str(&content)
                .map_err(|e| format!("Failed to parse profiles.yaml: {}", e))?;
            doc.profiles.retain(|p| p.id != profile_id);
            let updated_yaml = serde_yaml::to_string(&doc)
                .map_err(|e| format!("Failed to serialize profiles.yaml: {}", e))?;
            fs::write(&profiles_yaml_path, updated_yaml)
                .map_err(|e| format!("Failed to write profiles.yaml: {}", e))?;
        }
    }
    
    // 2. Remove from auth.json
    if auth_json_path.exists() {
        let content = fs::read_to_string(&auth_json_path)
            .map_err(|e| format!("Failed to read auth.json: {}", e))?;
        if !content.trim().is_empty() {
            let mut auth_data: std::collections::HashMap<String, AuthStorageItem> = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse auth.json: {}", e))?;
            auth_data.remove(&profile_id);
            let updated_json = serde_json::to_string_pretty(&auth_data)
                .map_err(|e| format!("Failed to serialize auth.json: {}", e))?;
            fs::write(&auth_json_path, updated_json)
                .map_err(|e| format!("Failed to write auth.json: {}", e))?;
        }
    }
    
    Ok(())
}

// ---------------------------------------------------------------------------
// Runtime adapter — Test (fake) / Live (pi) switch
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
/// Valid values: "fake" (Test) or "pi" / "pi-agent-core" (Live).
/// The new value takes effect on the next bridge start.
#[tauri::command]
pub fn set_runtime_adapter(adapter: String) -> Result<(), String> {
    let normalised = adapter.trim().to_lowercase();
    if normalised != "fake" && normalised != "pi" && normalised != "pi-agent-core" {
        return Err(format!(
            "Invalid adapter \"{}\". Use \"fake\" (Test) or \"pi\" (Live).",
            adapter
        ));
    }
    write_runtime_adapter_to_config(&normalised)
}
