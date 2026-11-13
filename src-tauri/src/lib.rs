use base64::{engine::general_purpose::STANDARD, Engine as _};
use discovery::Peer;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::fs;
use tokio::sync::Mutex;
use transport::NetworkPacket;
use uuid::Uuid;

mod crypto;
mod discovery;
mod transport;

struct AppState {
    my_id: Mutex<String>,
    my_username: Mutex<String>,
    room_key: Mutex<[u8; 32]>,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    started: Mutex<bool>,
}

#[derive(Serialize)]
pub struct FilePreviewResponse {
    pub file_type: String,
    pub mime_type: String,
    pub content: String,
    pub file_size: u64,
}

#[tauri::command]
async fn join_room(
    app: AppHandle,
    state: State<'_, AppState>,
    username: String,
    room_password: String,
) -> Result<(), String> {
    println!("Backend: {} giriş yaptı. Oda Parolası işleniyor...", username);

    let mut started = state.started.lock().await;
    if *started {
        return Ok(());
    }

    let my_id = Uuid::new_v4().to_string();
    *state.my_id.lock().await = my_id.clone();
    *state.my_username.lock().await = username.clone();

    let key = crypto::derive_room_key(&room_password);
    *state.room_key.lock().await = key;

    discovery::start_discovery(app.clone(), my_id, username, state.peers.clone()).await;
    transport::start_tcp_server(app, key).await;

    *started = true;
    Ok(())
}

#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    target_id: Option<String>,
    text: String,
) -> Result<(), String> {
    let my_id = state.my_id.lock().await.clone();
    let my_username = state.my_username.lock().await.clone();
    let key = *state.room_key.lock().await;
    let peers_map = state.peers.lock().await.clone();
    let timestamp = transport::current_time_str();

    match target_id {
        Some(target) => {
            let peer = peers_map
                .values()
                .find(|p| p.id == target || p.ip == target)
                .ok_or_else(|| "Hedef kullanıcı ağda bulunamadı!".to_string())?;

            let packet = NetworkPacket::Text {
                sender_id: my_id,
                sender_name: my_username,
                text,
                timestamp,
                is_private: true,
            };
            transport::send_packet(&peer.ip, key, &packet).await?;
        }
        None => {
            let packet = NetworkPacket::Text {
                sender_id: my_id,
                sender_name: my_username,
                text,
                timestamp,
                is_private: false,
            };
            for peer in peers_map.values() {
                let _ = transport::send_packet(&peer.ip, key, &packet).await;
            }
        }
    }

    Ok(())
}

async fn send_file_internal(
    state: &AppState,
    target_id: Option<String>,
    file_path: &str,
) -> Result<(), String> {
    let my_id = state.my_id.lock().await.clone();
    let my_username = state.my_username.lock().await.clone();
    let key = *state.room_key.lock().await;
    let peers_map = state.peers.lock().await.clone();
    let timestamp = transport::current_time_str();

    let data = fs::read(file_path)
        .await
        .map_err(|e| format!("Dosya okunamadı: {}", e))?;

    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("dosya")
        .to_string();

    match target_id {
        Some(target) => {
            let peer = peers_map
                .values()
                .find(|p| p.id == target || p.ip == target)
                .ok_or_else(|| "Hedef kullanıcı ağda bulunamadı!".to_string())?;

            let packet = NetworkPacket::File {
                sender_id: my_id,
                sender_name: my_username,
                file_name,
                data,
                timestamp,
                is_private: true,
            };
            transport::send_packet(&peer.ip, key, &packet).await?;
        }
        None => {
            let packet = NetworkPacket::File {
                sender_id: my_id,
                sender_name: my_username,
                file_name,
                data,
                timestamp,
                is_private: false,
            };
            for peer in peers_map.values() {
                let _ = transport::send_packet(&peer.ip, key, &packet).await;
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn send_file(
    state: State<'_, AppState>,
    target_id: Option<String>,
    file_path: String,
) -> Result<(), String> {
    send_file_internal(&state, target_id, &file_path).await
}

#[tauri::command]
async fn read_file_preview(file_path: String) -> Result<FilePreviewResponse, String> {
    let meta = fs::metadata(&file_path)
        .await
        .map_err(|e| format!("Dosya bulunamadı veya erişilemiyor: {}", e))?;

    let file_size = meta.len();
    let ext = Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" => {
            const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
            if file_size > MAX_IMAGE_BYTES {
                return Err("Görsel önizleme için çok büyük (Max 15MB)".into());
            }

            let mime_type = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                _ => "application/octet-stream",
            };

            let bytes = fs::read(&file_path)
                .await
                .map_err(|e| format!("Görsel okunamadı: {}", e))?;

            let encoded = STANDARD.encode(&bytes);
            let content = format!("data:{};base64,{}", mime_type, encoded);

            Ok(FilePreviewResponse {
                file_type: "image".to_string(),
                mime_type: mime_type.to_string(),
                content,
                file_size,
            })
        }
        "txt" | "log" | "md" | "json" | "csv" | "xml" | "yml" | "yaml" => {
            let mime_type = match ext.as_str() {
                "json" => "application/json",
                "md" => "text/markdown",
                "csv" => "text/csv",
                _ => "text/plain",
            };

            let bytes = fs::read(&file_path)
                .await
                .map_err(|e| format!("Metin dosyası okunamadı: {}", e))?;

            const MAX_TEXT_BYTES: usize = 512 * 1024;
            let content = if bytes.len() > MAX_TEXT_BYTES {
                let mut truncated = String::from_utf8_lossy(&bytes[..MAX_TEXT_BYTES]).to_string();
                truncated.push_str("\n\n--- [Dosya boyutu büyük olduğu için ilk 512 KB gösteriliyor] ---");
                truncated
            } else {
                String::from_utf8_lossy(&bytes).to_string()
            };

            Ok(FilePreviewResponse {
                file_type: "text".to_string(),
                mime_type: mime_type.to_string(),
                content,
                file_size,
            })
        }
        _ => Err("Bu dosya türü uygulama içi önizlemeyi desteklemiyor.".into()),
    }
}

#[tauri::command]
async fn send_clipboard_image(
    state: State<'_, AppState>,
    target_id: Option<String>,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    let pure_base64 = match base64_data.split_once(',') {
        Some((_, b64)) => b64,
        None => base64_data.as_str(),
    };

    let bytes = STANDARD
        .decode(pure_base64.trim())
        .map_err(|e| format!("Base64 görsel verisi çözümlenemedi: {}", e))?;

    let temp_dir = std::env::temp_dir().join("labchat_clipboard");
    fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Geçici dizin oluşturulamadı: {}", e))?;

    let raw_name = Path::new(&file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clipboard_image.png");
    let safe_name = raw_name.replace("/", "_").replace(char::from(92), "_");

    let saved_path = temp_dir.join(safe_name);
    fs::write(&saved_path, &bytes)
        .await
        .map_err(|e| format!("Görsel diske yazılamadı: {}", e))?;

    let saved_path_str = saved_path.to_string_lossy().to_string();
    send_file_internal(&state, target_id, &saved_path_str).await?;

    Ok(saved_path_str)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            my_id: Mutex::new(String::new()),
            my_username: Mutex::new(String::new()),
            room_key: Mutex::new([0u8; 32]),
            peers: Arc::new(Mutex::new(HashMap::new())),
            started: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            join_room,
            send_message,
            send_file,
            read_file_preview,
            send_clipboard_image
        ])
        .run(tauri::generate_context!())
        .expect("Tauri backend motoru çöktü!");
}
