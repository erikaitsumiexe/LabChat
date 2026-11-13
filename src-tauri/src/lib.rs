use discovery::Peer;
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

#[tauri::command]
async fn send_file(
    state: State<'_, AppState>,
    target_id: Option<String>,
    file_path: String,
) -> Result<(), String> {
    let my_id = state.my_id.lock().await.clone();
    let my_username = state.my_username.lock().await.clone();
    let key = *state.room_key.lock().await;
    let peers_map = state.peers.lock().await.clone();
    let timestamp = transport::current_time_str();

    let data = fs::read(&file_path)
        .await
        .map_err(|e| format!("Dosya okunamadı: {}", e))?;

    let file_name = Path::new(&file_path)
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
            send_file
        ])
        .run(tauri::generate_context!())
        .expect("Tauri backend motoru çöktü!");
}
