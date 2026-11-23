use base64::{engine::general_purpose::STANDARD, Engine as _};
use crypto::CryptoSession;
use discovery::{save_known_peers, Peer};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::fs;
use tokio::sync::{mpsc, Mutex};
use transport::{MessageStatus, NetworkPacket, OutboxItem};
use uuid::Uuid;

mod crypto;
mod discovery;
mod transport;

// Uygulamaya gömülü Admin Panel şifresi
const ADMIN_SECRET_PASSWORD: &str = "pati";

fn compute_admin_signature(password: &str) -> String {
    blake3::hash(format!("labchat_admin_sig::{}", password).as_bytes())
        .to_hex()
        .to_string()
}

struct AppState {
    my_id: Mutex<String>,
    my_username: Mutex<String>,
    my_avatar: Mutex<Option<String>>,
    room_key: Mutex<[u8; 32]>,
    crypto_session: Mutex<Option<CryptoSession>>,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    banned_ids: Arc<Mutex<HashSet<String>>>,
    globally_muted_ids: Arc<Mutex<HashSet<String>>>,
    locally_muted_ids: Arc<Mutex<HashSet<String>>>,
    outbox: Arc<Mutex<Vec<OutboxItem>>>,
    started: Mutex<bool>,
}

#[derive(Serialize)]
pub struct FilePreviewResponse {
    pub file_type: String,
    pub mime_type: String,
    pub content: String,
    pub file_size: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct IdentityStore {
    users: HashMap<String, String>,
}

fn identity_file_path() -> PathBuf {
    let dir = std::env::temp_dir().join("labchat_state");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("identity.json")
}

async fn get_or_create_persistent_id(username: &str) -> String {
    let path = identity_file_path();
    let mut store = if let Ok(bytes) = fs::read(&path).await {
        serde_json::from_slice::<IdentityStore>(&bytes).unwrap_or_default()
    } else {
        IdentityStore::default()
    };

    if let Some(existing_id) = store.users.get(username) {
        return existing_id.clone();
    }

    let new_id = Uuid::new_v4().to_string();
    store.users.insert(username.to_string(), new_id.clone());
    if let Ok(json) = serde_json::to_vec_pretty(&store) {
        let _ = fs::write(&path, json).await;
    }
    new_id
}

#[tauri::command]
async fn join_room(
    app: AppHandle,
    state: State<'_, AppState>,
    username: String,
    room_password: String,
) -> Result<(), String> {
    let mut started = state.started.lock().await;
    if *started {
        return Ok(());
    }

    let my_id = get_or_create_persistent_id(&username).await;
    *state.my_id.lock().await = my_id.clone();
    *state.my_username.lock().await = username.clone();

    let key = crypto::derive_room_key(&room_password);
    *state.room_key.lock().await = key;

    let session = CryptoSession::new();
    let pub_key_bytes = session.public_key.to_bytes();
    *state.crypto_session.lock().await = Some(session.clone());

    let saved_outbox = transport::load_outbox().await;
    *state.outbox.lock().await = saved_outbox;

    let (online_tx, mut online_rx) = mpsc::unbounded_channel::<Peer>();
    let app_flush = app.clone();
    let session_flush = session.clone();
    let outbox_flush = state.outbox.clone();

    tokio::spawn(async move {
        while let Some(peer) = online_rx.recv().await {
            transport::flush_outbox_for_peer(&app_flush, &peer, key, &session_flush, &outbox_flush)
                .await;
        }
    });

    let expected_sig = compute_admin_signature(ADMIN_SECRET_PASSWORD);

    discovery::start_discovery(
        app.clone(),
        my_id.clone(),
        username,
        pub_key_bytes,
        state.peers.clone(),
        state.banned_ids.clone(),
        state.globally_muted_ids.clone(),
        state.locally_muted_ids.clone(),
        online_tx,
    )
    .await;

    transport::start_tcp_server(
        app,
        my_id,
        key,
        expected_sig,
        session,
        state.peers.clone(),
        state.banned_ids.clone(),
        state.globally_muted_ids.clone(),
        state.locally_muted_ids.clone(),
    )
    .await;

    *started = true;
    Ok(())
}

#[tauri::command]
fn verify_admin_password(password: String) -> bool {
    password == ADMIN_SECRET_PASSWORD
}

#[tauri::command]
async fn admin_moderate_user(
    app: AppHandle,
    state: State<'_, AppState>,
    admin_password: String,
    target_id: String,
    action: String,
) -> Result<(), String> {
    if admin_password != ADMIN_SECRET_PASSWORD {
        return Err("Yetkisiz işlem: Hatalı Admin şifresi!".to_string());
    }

    let sig = compute_admin_signature(&admin_password);
    let room_key = *state.room_key.lock().await;
    let peers_snapshot = state.peers.lock().await.clone();

    match action.as_str() {
        "ban" => {
            state.banned_ids.lock().await.insert(target_id.clone());
            let mut p_map = state.peers.lock().await;
            p_map.remove(&target_id);
            let list: Vec<Peer> = p_map.values().cloned().collect();
            let _ = app.emit("peers-updated", list);
            save_known_peers(&p_map).await;
        }
        "unban" => {
            state.banned_ids.lock().await.remove(&target_id);
        }
        "mute" => {
            state
                .globally_muted_ids
                .lock()
                .await
                .insert(target_id.clone());
            let mut p_map = state.peers.lock().await;
            if let Some(p) = p_map.get_mut(&target_id) {
                p.is_muted = true;
            }
            let list: Vec<Peer> = p_map.values().cloned().collect();
            let _ = app.emit("peers-updated", list);
        }
        "unmute" => {
            state.globally_muted_ids.lock().await.remove(&target_id);
            let mut p_map = state.peers.lock().await;
            if let Some(p) = p_map.get_mut(&target_id) {
                p.is_muted = false;
            }
            let list: Vec<Peer> = p_map.values().cloned().collect();
            let _ = app.emit("peers-updated", list);
        }
        _ => return Err("Geçersiz admin aksiyonu".to_string()),
    }

    let packet = NetworkPacket::AdminAction {
        action,
        target_id,
        admin_signature: sig,
    };

    for peer in peers_snapshot.values().filter(|p| p.online) {
        let _ = transport::send_packet(&peer.ip, room_key, &packet).await;
    }

    Ok(())
}

#[tauri::command]
async fn set_peer_muted(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    muted: bool,
) -> Result<(), String> {
    if muted {
        state.locally_muted_ids.lock().await.insert(peer_id.clone());
    } else {
        state.locally_muted_ids.lock().await.remove(&peer_id);
    }

    let is_globally_muted = state.globally_muted_ids.lock().await.contains(&peer_id);
    let mut p_map = state.peers.lock().await;
    if let Some(p) = p_map.get_mut(&peer_id) {
        p.is_muted = muted || is_globally_muted;
    }
    let list: Vec<Peer> = p_map.values().cloned().collect();
    let _ = app.emit("peers-updated", list);
    save_known_peers(&p_map).await;
    Ok(())
}

#[tauri::command]
async fn remove_peer(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<(), String> {
    let mut p_map = state.peers.lock().await;
    p_map.remove(&peer_id);
    let list: Vec<Peer> = p_map.values().cloned().collect();
    let _ = app.emit("peers-updated", list);
    save_known_peers(&p_map).await;
    Ok(())
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: Option<String>,
    text: String,
) -> Result<String, String> {
    let my_id = state.my_id.lock().await.clone();
    if state.banned_ids.lock().await.contains(&my_id) {
        return Err("Odadan yasaklandınız!".to_string());
    }
    if state.globally_muted_ids.lock().await.contains(&my_id) {
        return Err("Admin tarafından susturuldunuz!".to_string());
    }

    let my_username = state.my_username.lock().await.clone();
    let room_key = *state.room_key.lock().await;
    let session = state
        .crypto_session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Oturum henüz başlatılmadı!".to_string())?;
    let peers_map = state.peers.lock().await.clone();
    let timestamp = transport::current_time_str();
    let msg_id = Uuid::new_v4().to_string();

    match target_id {
        Some(target) => {
            let peer_opt = peers_map
                .values()
                .find(|p| p.id == target || p.ip == target)
                .cloned();

            let mut delivered_now = false;
            if let Some(ref peer) = peer_opt {
                if peer.online {
                    let dm_key = session.compute_dm_key(&peer.public_key, &room_key);
                    let packet = NetworkPacket::Text {
                        msg_id: msg_id.clone(),
                        sender_id: my_id.clone(),
                        sender_name: my_username.clone(),
                        text: text.clone(),
                        timestamp: timestamp.clone(),
                        is_private: true,
                    };
                    if transport::send_packet(&peer.ip, dm_key, &packet).await.is_ok() {
                        delivered_now = true;
                    }
                }
            }

            if !delivered_now {
                let real_target_id = peer_opt.map(|p| p.id).unwrap_or(target);
                transport::enqueue_outbox(
                    &state.outbox,
                    OutboxItem {
                        msg_id: msg_id.clone(),
                        target_id: real_target_id,
                        sender_id: my_id,
                        sender_name: my_username,
                        timestamp,
                        kind: "text".to_string(),
                        text: Some(text),
                        file_path: None,
                    },
                )
                .await;
                let _ = app.emit(
                    "message-status",
                    MessageStatus {
                        msg_id: msg_id.clone(),
                        status: "queued".to_string(),
                    },
                );
            }
        }
        None => {
            let packet = NetworkPacket::Text {
                msg_id: msg_id.clone(),
                sender_id: my_id,
                sender_name: my_username,
                text,
                timestamp,
                is_private: false,
            };
            for peer in peers_map.values().filter(|p| p.online) {
                let _ = transport::send_packet(&peer.ip, room_key, &packet).await;
            }
        }
    }

    Ok(msg_id)
}

async fn send_file_internal(
    app: &AppHandle,
    state: &AppState,
    target_id: Option<String>,
    file_path: &str,
) -> Result<String, String> {
    let my_id = state.my_id.lock().await.clone();
    if state.banned_ids.lock().await.contains(&my_id) {
        return Err("Odadan yasaklandınız!".to_string());
    }
    if state.globally_muted_ids.lock().await.contains(&my_id) {
        return Err("Admin tarafından susturuldunuz!".to_string());
    }

    let my_username = state.my_username.lock().await.clone();
    let room_key = *state.room_key.lock().await;
    let session = state
        .crypto_session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Oturum henüz başlatılmadı!".to_string())?;
    let peers_map = state.peers.lock().await.clone();
    let timestamp = transport::current_time_str();
    let msg_id = Uuid::new_v4().to_string();

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
            let peer_opt = peers_map
                .values()
                .find(|p| p.id == target || p.ip == target)
                .cloned();

            let mut delivered_now = false;
            if let Some(ref peer) = peer_opt {
                if peer.online {
                    let dm_key = session.compute_dm_key(&peer.public_key, &room_key);
                    let packet = NetworkPacket::File {
                        msg_id: msg_id.clone(),
                        sender_id: my_id.clone(),
                        sender_name: my_username.clone(),
                        file_name,
                        data,
                        timestamp: timestamp.clone(),
                        is_private: true,
                    };
                    if transport::send_packet(&peer.ip, dm_key, &packet).await.is_ok() {
                        delivered_now = true;
                    }
                }
            }

            if !delivered_now {
                let real_target_id = peer_opt.map(|p| p.id).unwrap_or(target);
                transport::enqueue_outbox(
                    &state.outbox,
                    OutboxItem {
                        msg_id: msg_id.clone(),
                        target_id: real_target_id,
                        sender_id: my_id,
                        sender_name: my_username,
                        timestamp,
                        kind: "file".to_string(),
                        text: None,
                        file_path: Some(file_path.to_string()),
                    },
                )
                .await;
                let _ = app.emit(
                    "message-status",
                    MessageStatus {
                        msg_id: msg_id.clone(),
                        status: "queued".to_string(),
                    },
                );
            }
        }
        None => {
            let packet = NetworkPacket::File {
                msg_id: msg_id.clone(),
                sender_id: my_id,
                sender_name: my_username,
                file_name,
                data,
                timestamp,
                is_private: false,
            };
            for peer in peers_map.values().filter(|p| p.online) {
                let _ = transport::send_packet(&peer.ip, room_key, &packet).await;
            }
        }
    }

    Ok(msg_id)
}

#[tauri::command]
async fn send_file(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: Option<String>,
    file_path: String,
) -> Result<String, String> {
    send_file_internal(&app, &state, target_id, &file_path).await
}

#[tauri::command]
async fn mark_as_read(
    state: State<'_, AppState>,
    peer_id: String,
    msg_ids: Vec<String>,
) -> Result<(), String> {
    if msg_ids.is_empty() {
        return Ok(());
    }

    let my_id = state.my_id.lock().await.clone();
    let room_key = *state.room_key.lock().await;
    let session = state
        .crypto_session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Oturum henüz başlatılmadı!".to_string())?;
    let peers_map = state.peers.lock().await.clone();

    if let Some(peer) = peers_map
        .values()
        .find(|p| p.id == peer_id || p.ip == peer_id)
    {
        if peer.online {
            let dm_key = session.compute_dm_key(&peer.public_key, &room_key);
            let packet = NetworkPacket::Read {
                msg_ids,
                sender_id: my_id,
            };
            let _ = transport::send_packet(&peer.ip, dm_key, &packet).await;
        }
    }

    Ok(())
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
    app: AppHandle,
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
    let _msg_id = send_file_internal(&app, &state, target_id, &saved_path_str).await?;

    Ok(saved_path_str)
}

#[tauri::command]
async fn set_avatar(
    app: AppHandle,
    state: State<'_, AppState>,
    avatar_base64: Option<String>,
) -> Result<(), String> {
    if let Some(ref data) = avatar_base64 {
        if data.len() > 2 * 1024 * 1024 {
            return Err("Profil fotoğrafı en fazla 1.5 MB olabilir.".to_string());
        }
    }

    *state.my_avatar.lock().await = avatar_base64.clone();
    let dir = std::env::temp_dir().join("labchat_state");
    let _ = std::fs::create_dir_all(&dir);
    let avatar_path = dir.join("my_avatar.txt");
    if let Some(ref data) = avatar_base64 {
        let _ = fs::write(&avatar_path, data).await;
    } else {
        let _ = fs::remove_file(&avatar_path).await;
    }

    let my_id = state.my_id.lock().await.clone();
    let my_username = state.my_username.lock().await.clone();
    let room_key = *state.room_key.lock().await;
    let peers_snapshot: Vec<Peer> = state.peers.lock().await.values().cloned().collect();

    let packet = NetworkPacket::ProfileUpdate {
        sender_id: my_id,
        sender_name: my_username,
        avatar: avatar_base64.clone(),
    };

    for peer in peers_snapshot {
        if peer.online {
            let ip = peer.ip.clone();
            let pkt = packet.clone();
            tokio::spawn(async move {
                let _ = transport::send_packet(&ip, room_key, &pkt).await;
            });
        }
    }

    let _ = app.emit("my-avatar-updated", avatar_base64);
    Ok(())
}

#[tauri::command]
async fn get_my_avatar(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let current = state.my_avatar.lock().await.clone();
    if current.is_some() {
        return Ok(current);
    }
    let path = std::env::temp_dir().join("labchat_state").join("my_avatar.txt");
    if let Ok(data) = fs::read_to_string(path).await {
        if !data.trim().is_empty() {
            *state.my_avatar.lock().await = Some(data.clone());
            return Ok(Some(data));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn send_typing(
    state: State<'_, AppState>,
    target_id: Option<String>,
    is_typing: bool,
) -> Result<(), String> {
    let my_id = state.my_id.lock().await.clone();
    if my_id.is_empty() {
        return Ok(());
    }
    let my_username = state.my_username.lock().await.clone();
    let room_key = *state.room_key.lock().await;
    let is_private = target_id.is_some();

    let packet = NetworkPacket::Typing {
        sender_id: my_id,
        sender_name: my_username,
        is_typing,
        is_private,
    };

    let peers_map = state.peers.lock().await;
    if let Some(tid) = target_id {
        if let Some(peer) = peers_map.get(&tid) {
            if peer.online {
                let ip = peer.ip.clone();
                tokio::spawn(async move {
                    let _ = transport::send_packet(&ip, room_key, &packet).await;
                });
            }
        }
    } else {
        for peer in peers_map.values() {
            if peer.online {
                let ip = peer.ip.clone();
                let pkt = packet.clone();
                tokio::spawn(async move {
                    let _ = transport::send_packet(&ip, room_key, &pkt).await;
                });
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
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            my_id: Mutex::new(String::new()),
            my_username: Mutex::new(String::new()),
            my_avatar: Mutex::new(None),
            room_key: Mutex::new([0u8; 32]),
            crypto_session: Mutex::new(None),
            peers: Arc::new(Mutex::new(HashMap::new())),
            banned_ids: Arc::new(Mutex::new(HashSet::new())),
            globally_muted_ids: Arc::new(Mutex::new(HashSet::new())),
            locally_muted_ids: Arc::new(Mutex::new(HashSet::new())),
            outbox: Arc::new(Mutex::new(Vec::new())),
            started: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            join_room,
            send_message,
            send_file,
            mark_as_read,
            read_file_preview,
            send_clipboard_image,
            verify_admin_password,
            admin_moderate_user,
            set_peer_muted,
            remove_peer,
            set_avatar,
            get_my_avatar,
            send_typing
        ])
        .run(tauri::generate_context!())
        .expect("Tauri backend motoru çöktü!");
}
