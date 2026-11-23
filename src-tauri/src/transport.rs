use crate::crypto::{self, CryptoSession};
use crate::discovery::{save_known_peers, Peer};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const TCP_PORT: u16 = 54322;

#[derive(Serialize, Clone)]
pub struct TypingPayload {
    pub sender_id: String,
    pub sender_name: String,
    pub is_typing: bool,
    pub is_private: bool,
    pub avatar: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind")]
pub enum NetworkPacket {
    Typing {
        sender_id: String,
        sender_name: String,
        is_typing: bool,
        is_private: bool,
    },
    ProfileUpdate {
        sender_id: String,
        sender_name: String,
        avatar: Option<String>,
    },
    Text {
        msg_id: String,
        sender_id: String,
        sender_name: String,
        text: String,
        timestamp: String,
        is_private: bool,
    },
    File {
        msg_id: String,
        sender_id: String,
        sender_name: String,
        file_name: String,
        data: Vec<u8>,
        timestamp: String,
        is_private: bool,
    },
    Ack {
        msg_id: String,
        sender_id: String,
    },
    Read {
        msg_ids: Vec<String>,
        sender_id: String,
    },
    AdminAction {
        action: String, // "ban" | "unban" | "mute" | "unmute"
        target_id: String,
        admin_signature: String,
    },
}

#[derive(Clone, Serialize)]
pub struct ReceivedMessage {
    pub msg_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub text: String,
    pub timestamp: String,
    pub is_private: bool,
}

#[derive(Clone, Serialize)]
pub struct ReceivedFile {
    pub msg_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub file_path: String,
    pub file_name: String,
    pub timestamp: String,
    pub is_private: bool,
}

#[derive(Clone, Serialize)]
pub struct MessageAck {
    pub msg_id: String,
    pub sender_id: String,
}

#[derive(Clone, Serialize)]
pub struct MessageRead {
    pub msg_ids: Vec<String>,
    pub sender_id: String,
}

#[derive(Clone, Serialize)]
pub struct MessageStatus {
    pub msg_id: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
pub struct AdminNotice {
    pub action: String,
    pub target_id: String,
    pub is_self: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OutboxItem {
    pub msg_id: String,
    pub target_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub timestamp: String,
    pub kind: String,
    pub text: Option<String>,
    pub file_path: Option<String>,
}

fn send_desktop_notification(app: &AppHandle, title: &str, body: &str) {
    let should_notify = match app.get_webview_window("main") {
        Some(win) => {
            let visible = win.is_visible().unwrap_or(false);
            let focused = win.is_focused().unwrap_or(false);
            !visible || !focused
        }
        None => true,
    };

    if should_notify {
        let preview: String = body.chars().take(100).collect();
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(&preview)
            .show();
    }
}

fn outbox_file_path() -> PathBuf {
    let dir = std::env::temp_dir().join("labchat_state");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("outbox_queue.json")
}

pub async fn load_outbox() -> Vec<OutboxItem> {
    if let Ok(bytes) = fs::read(outbox_file_path()).await {
        if let Ok(items) = serde_json::from_slice::<Vec<OutboxItem>>(&bytes) {
            return items;
        }
    }
    Vec::new()
}

pub async fn save_outbox(items: &[OutboxItem]) {
    if let Ok(json) = serde_json::to_vec_pretty(items) {
        let _ = fs::write(outbox_file_path(), json).await;
    }
}

pub async fn enqueue_outbox(outbox: &Arc<Mutex<Vec<OutboxItem>>>, item: OutboxItem) {
    let mut list = outbox.lock().await;
    list.push(item);
    save_outbox(&list).await;
}

pub async fn flush_outbox_for_peer(
    app: &AppHandle,
    peer: &Peer,
    room_key: [u8; 32],
    session: &CryptoSession,
    outbox: &Arc<Mutex<Vec<OutboxItem>>>,
) {
    let pending: Vec<OutboxItem> = {
        let list = outbox.lock().await;
        list.iter()
            .filter(|i| i.target_id == peer.id || i.target_id == peer.ip)
            .cloned()
            .collect()
    };

    if pending.is_empty() {
        return;
    }

    let dm_key = session.compute_dm_key(&peer.public_key, &room_key);
    let mut delivered_ids = Vec::new();

    for item in pending {
        let packet_opt = if item.kind == "text" {
            item.text.map(|t| NetworkPacket::Text {
                msg_id: item.msg_id.clone(),
                sender_id: item.sender_id.clone(),
                sender_name: item.sender_name.clone(),
                text: t,
                timestamp: item.timestamp.clone(),
                is_private: true,
            })
        } else if let Some(fp) = &item.file_path {
            if let Ok(data) = fs::read(fp).await {
                let file_name = std::path::Path::new(fp)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("dosya")
                    .to_string();
                Some(NetworkPacket::File {
                    msg_id: item.msg_id.clone(),
                    sender_id: item.sender_id.clone(),
                    sender_name: item.sender_name.clone(),
                    file_name,
                    data,
                    timestamp: item.timestamp.clone(),
                    is_private: true,
                })
            } else {
                delivered_ids.push(item.msg_id.clone());
                None
            }
        } else {
            None
        };

        if let Some(packet) = packet_opt {
            if send_packet(&peer.ip, dm_key, &packet).await.is_ok() {
                delivered_ids.push(item.msg_id.clone());
                let _ = app.emit(
                    "message-status",
                    MessageStatus {
                        msg_id: item.msg_id,
                        status: "sent".to_string(),
                    },
                );
            }
        }
    }

    if !delivered_ids.is_empty() {
        let mut list = outbox.lock().await;
        list.retain(|i| !delivered_ids.contains(&i.msg_id));
        save_outbox(&list).await;
    }
}

pub fn current_time_str() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let local_secs = secs + 3 * 3600;
    let hours = (local_secs / 3600) % 24;
    let minutes = (local_secs / 60) % 60;
    let seconds = local_secs % 60;
    format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
}

pub async fn start_tcp_server(
    app: AppHandle,
    my_id: String,
    room_key: [u8; 32],
    expected_admin_sig: String,
    session: CryptoSession,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    banned_ids: Arc<Mutex<HashSet<String>>>,
    globally_muted_ids: Arc<Mutex<HashSet<String>>>,
    locally_muted_ids: Arc<Mutex<HashSet<String>>>,
) {
    let listener = TcpListener::bind(format!("0.0.0.0:{}", TCP_PORT))
        .await
        .expect("TCP Portu (54322) dinlenemiyor!");

    tokio::spawn(async move {
        loop {
            if let Ok((mut socket, peer_addr)) = listener.accept().await {
                let remote_ip = peer_addr.ip().to_string();
                let app_clone = app.clone();
                let my_id_clone = my_id.clone();
                let room_key_clone = room_key;
                let admin_sig_clone = expected_admin_sig.clone();
                let session_clone = session.clone();
                let peers_clone = peers.clone();
                let banned_clone = banned_ids.clone();
                let g_muted_clone = globally_muted_ids.clone();
                let l_muted_clone = locally_muted_ids.clone();

                tokio::spawn(async move {
                    let mut length_buf = [0u8; 4];
                    if socket.read_exact(&mut length_buf).await.is_ok() {
                        let payload_len = u32::from_be_bytes(length_buf) as usize;
                        if payload_len > 100 * 1024 * 1024 {
                            return;
                        }

                        let mut encrypted_buf = vec![0u8; payload_len];
                        if socket.read_exact(&mut encrypted_buf).await.is_ok() {
                            let mut decrypted =
                                crypto::decrypt(&room_key_clone, &encrypted_buf).ok();
                            let mut used_key = room_key_clone;

                            if decrypted.is_none() {
                                let p_map = peers_clone.lock().await;
                                for peer in p_map.values() {
                                    let dm_key = session_clone
                                        .compute_dm_key(&peer.public_key, &room_key_clone);
                                    if let Ok(plain) = crypto::decrypt(&dm_key, &encrypted_buf) {
                                        decrypted = Some(plain);
                                        used_key = dm_key;
                                        break;
                                    }
                                }
                            }

                            if let Some(decrypted_bytes) = decrypted {
                                if let Ok(packet) =
                                    serde_json::from_slice::<NetworkPacket>(&decrypted_bytes)
                                {
                                    match packet {
                                        NetworkPacket::Typing {
                                            sender_id,
                                            sender_name,
                                            is_typing,
                                            is_private,
                                        } => {
                                            if banned_clone.lock().await.contains(&sender_id)
                                                || g_muted_clone.lock().await.contains(&sender_id)
                                            {
                                                return;
                                            }
                                            let avatar = {
                                                let mut p_map = peers_clone.lock().await;
                                                let entry = p_map.entry(sender_id.clone()).or_insert_with(|| Peer {
                                                    id: sender_id.clone(),
                                                    username: sender_name.clone(),
                                                    ip: remote_ip.clone(),
                                                    public_key: [0u8; 32],
                                                    online: true,
                                                    last_seen: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
                                                    is_muted: false,
                                                    avatar: None,
                                                });
                                                entry.ip = remote_ip.clone();
                                                entry.online = true;
                                                entry.last_seen = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                                entry.avatar.clone()
                                            };
                                            let _ = app_clone.emit("peer-typing", TypingPayload {
                                                sender_id,
                                                sender_name,
                                                is_typing,
                                                is_private,
                                                avatar,
                                            });
                                        }
                                        NetworkPacket::ProfileUpdate {
                                            sender_id,
                                            sender_name,
                                            avatar,
                                        } => {
                                            if banned_clone.lock().await.contains(&sender_id) {
                                                return;
                                            }
                                            let mut p_map = peers_clone.lock().await;
                                            let entry = p_map.entry(sender_id.clone()).or_insert_with(|| Peer {
                                                id: sender_id.clone(),
                                                username: sender_name.clone(),
                                                ip: remote_ip.clone(),
                                                public_key: [0u8; 32],
                                                online: true,
                                                last_seen: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
                                                is_muted: false,
                                                avatar: avatar.clone(),
                                            });
                                            entry.ip = remote_ip.clone();
                                            entry.username = sender_name;
                                            entry.avatar = avatar;
                                            entry.online = true;
                                            entry.last_seen = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                            let peer_list: Vec<Peer> = p_map.values().cloned().collect();
                                            let _ = app_clone.emit("peers-updated", peer_list);
                                            save_known_peers(&p_map).await;
                                        }
                                        NetworkPacket::Text {
                                            msg_id,
                                            sender_id,
                                            sender_name,
                                            text,
                                            timestamp,
                                            is_private,
                                        } => {
                                            if banned_clone.lock().await.contains(&sender_id)
                                                || g_muted_clone.lock().await.contains(&sender_id)
                                            {
                                                return;
                                            }

                                            let sender_ip = {
                                                let mut p_map = peers_clone.lock().await;
                                                let entry = p_map.entry(sender_id.clone()).or_insert_with(|| Peer {
                                                    id: sender_id.clone(),
                                                    username: sender_name.clone(),
                                                    ip: remote_ip.clone(),
                                                    public_key: [0u8; 32],
                                                    online: true,
                                                    last_seen: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
                                                    is_muted: false,
                                                    avatar: None,
                                                });
                                                entry.ip = remote_ip.clone();
                                                entry.username = sender_name.clone();
                                                entry.online = true;
                                                entry.last_seen = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                                let peer_list: Vec<Peer> = p_map.values().cloned().collect();
                                                let _ = app_clone.emit("peers-updated", peer_list);
                                                Some(remote_ip.clone())
                                            };

                                            if !l_muted_clone.lock().await.contains(&sender_id) {
                                                let title = if is_private {
                                                    format!("{} (Özel Mesaj)", sender_name)
                                                } else {
                                                    format!("{} (#Genel)", sender_name)
                                                };
                                                send_desktop_notification(&app_clone, &title, &text);
                                            }

                                            let ui_msg = ReceivedMessage {
                                                msg_id: msg_id.clone(),
                                                sender_id,
                                                sender_name,
                                                text,
                                                timestamp,
                                                is_private,
                                            };
                                            let _ = app_clone.emit("message-received", ui_msg);

                                            if let Some(ip) = sender_ip {
                                                let ack = NetworkPacket::Ack {
                                                    msg_id,
                                                    sender_id: my_id_clone,
                                                };
                                                let _ = send_packet(&ip, used_key, &ack).await;
                                            }
                                        }
                                        NetworkPacket::File {
                                            msg_id,
                                            sender_id,
                                            sender_name,
                                            file_name,
                                            data,
                                            timestamp,
                                            is_private,
                                        } => {
                                            if banned_clone.lock().await.contains(&sender_id)
                                                || g_muted_clone.lock().await.contains(&sender_id)
                                            {
                                                return;
                                            }

                                            if let Ok(saved_path) =
                                                save_incoming_file(&file_name, &data).await
                                            {
                                                let sender_ip = {
                                                    let p_map = peers_clone.lock().await;
                                                    p_map.get(&sender_id).map(|p| p.ip.clone())
                                                };

                                                if !l_muted_clone.lock().await.contains(&sender_id) {
                                                    let title = if is_private {
                                                        format!("{} - Dosya Gönderdi", sender_name)
                                                    } else {
                                                        format!("{} (#Genel) - Dosya", sender_name)
                                                    };
                                                    send_desktop_notification(
                                                        &app_clone,
                                                        &title,
                                                        &file_name,
                                                    );
                                                }

                                                let ui_file = ReceivedFile {
                                                    msg_id: msg_id.clone(),
                                                    sender_id,
                                                    sender_name,
                                                    file_path: saved_path,
                                                    file_name,
                                                    timestamp,
                                                    is_private,
                                                };
                                                let _ = app_clone.emit("file-received", ui_file);

                                                if let Some(ip) = sender_ip {
                                                    let ack = NetworkPacket::Ack {
                                                        msg_id,
                                                        sender_id: my_id_clone,
                                                    };
                                                    let _ = send_packet(&ip, used_key, &ack).await;
                                                }
                                            }
                                        }
                                        NetworkPacket::Ack { msg_id, sender_id } => {
                                            let _ = app_clone.emit(
                                                "message-ack",
                                                MessageAck { msg_id, sender_id },
                                            );
                                        }
                                        NetworkPacket::Read { msg_ids, sender_id } => {
                                            let _ = app_clone.emit(
                                                "message-read",
                                                MessageRead { msg_ids, sender_id },
                                            );
                                        }
                                        NetworkPacket::AdminAction {
                                            action,
                                            target_id,
                                            admin_signature,
                                        } => {
                                            if admin_signature != admin_sig_clone {
                                                return;
                                            }

                                            let is_self = target_id == my_id_clone;
                                            match action.as_str() {
                                                "ban" => {
                                                    banned_clone
                                                        .lock()
                                                        .await
                                                        .insert(target_id.clone());
                                                    let mut p_map = peers_clone.lock().await;
                                                    p_map.remove(&target_id);
                                                    let list: Vec<Peer> =
                                                        p_map.values().cloned().collect();
                                                    let _ = app_clone.emit("peers-updated", list);
                                                    save_known_peers(&p_map).await;
                                                }
                                                "unban" => {
                                                    banned_clone.lock().await.remove(&target_id);
                                                }
                                                "mute" => {
                                                    g_muted_clone
                                                        .lock()
                                                        .await
                                                        .insert(target_id.clone());
                                                    let mut p_map = peers_clone.lock().await;
                                                    if let Some(p) = p_map.get_mut(&target_id) {
                                                        p.is_muted = true;
                                                    }
                                                    let list: Vec<Peer> =
                                                        p_map.values().cloned().collect();
                                                    let _ = app_clone.emit("peers-updated", list);
                                                }
                                                "unmute" => {
                                                    g_muted_clone.lock().await.remove(&target_id);
                                                    let mut p_map = peers_clone.lock().await;
                                                    if let Some(p) = p_map.get_mut(&target_id) {
                                                        p.is_muted = false;
                                                    }
                                                    let list: Vec<Peer> =
                                                        p_map.values().cloned().collect();
                                                    let _ = app_clone.emit("peers-updated", list);
                                                }
                                                _ => {}
                                            }

                                            let _ = app_clone.emit(
                                                "admin-notice",
                                                AdminNotice {
                                                    action,
                                                    target_id,
                                                    is_self,
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }
    });
}

async fn save_incoming_file(file_name: &str, data: &[u8]) -> Result<String, String> {
    let base_dir = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));

    let save_dir = base_dir.join("Downloads").join("LabChat");
    fs::create_dir_all(&save_dir)
        .await
        .map_err(|e| e.to_string())?;

    let safe_name = std::path::Path::new(file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("gelen_dosya");

    let target_path = save_dir.join(safe_name);
    fs::write(&target_path, data)
        .await
        .map_err(|e| e.to_string())?;

    Ok(target_path.to_string_lossy().to_string())
}

pub async fn send_packet(
    target_ip: &str,
    encryption_key: [u8; 32],
    packet: &NetworkPacket,
) -> Result<(), String> {
    let plaintext = serde_json::to_vec(packet).map_err(|e| e.to_string())?;
    let encrypted_payload = crypto::encrypt(&encryption_key, &plaintext)?;

    let mut stream = TcpStream::connect(format!("{}:{}", target_ip, TCP_PORT))
        .await
        .map_err(|e| format!("{} adresine bağlanılamadı: {}", target_ip, e))?;

    let len_bytes = (encrypted_payload.len() as u32).to_be_bytes();
    stream
        .write_all(&len_bytes)
        .await
        .map_err(|e| e.to_string())?;
    stream
        .write_all(&encrypted_payload)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
