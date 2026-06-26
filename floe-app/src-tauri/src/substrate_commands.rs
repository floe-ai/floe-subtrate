use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Could not determine user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".floe").join("auth"))
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
