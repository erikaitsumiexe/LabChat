use crate::crypto;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TCP_PORT: u16 = 54322;

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind")]
pub enum NetworkPacket {
    Text {
        sender_id: String,
        sender_name: String,
        text: String,
        timestamp: String,
        is_private: bool,
    },
    File {
        sender_id: String,
        sender_name: String,
        file_name: String,
        data: Vec<u8>,
        timestamp: String,
        is_private: bool,
    },
}

#[derive(Clone, Serialize)]
pub struct ReceivedMessage {
    pub sender_id: String,
    pub sender_name: String,
    pub text: String,
    pub timestamp: String,
    pub is_private: bool,
}

#[derive(Clone, Serialize)]
pub struct ReceivedFile {
    pub sender_id: String,
    pub sender_name: String,
    pub file_path: String,
    pub file_name: String,
    pub timestamp: String,
    pub is_private: bool,
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

pub async fn start_tcp_server(app: AppHandle, room_key: [u8; 32]) {
    let listener = TcpListener::bind(format!("0.0.0.0:{}", TCP_PORT))
        .await
        .expect("TCP Portu (54322) dinlenemiyor!");

    tokio::spawn(async move {
        loop {
            if let Ok((mut socket, _addr)) = listener.accept().await {
                let app_clone = app.clone();
                let key_clone = room_key;

                tokio::spawn(async move {
                    let mut length_buf = [0u8; 4];
                    if socket.read_exact(&mut length_buf).await.is_ok() {
                        let payload_len = u32::from_be_bytes(length_buf) as usize;
                        if payload_len > 100 * 1024 * 1024 {
                            return;
                        }

                        let mut encrypted_buf = vec![0u8; payload_len];
                        if socket.read_exact(&mut encrypted_buf).await.is_ok() {
                            if let Ok(decrypted_bytes) = crypto::decrypt(&key_clone, &encrypted_buf)
                            {
                                if let Ok(packet) =
                                    serde_json::from_slice::<NetworkPacket>(&decrypted_bytes)
                                {
                                    match packet {
                                        NetworkPacket::Text {
                                            sender_id,
                                            sender_name,
                                            text,
                                            timestamp,
                                            is_private,
                                        } => {
                                            let ui_msg = ReceivedMessage {
                                                sender_id,
                                                sender_name,
                                                text,
                                                timestamp,
                                                is_private,
                                            };
                                            let _ = app_clone.emit("message-received", ui_msg);
                                        }
                                        NetworkPacket::File {
                                            sender_id,
                                            sender_name,
                                            file_name,
                                            data,
                                            timestamp,
                                            is_private,
                                        } => {
                                            if let Ok(saved_path) =
                                                save_incoming_file(&file_name, &data).await
                                            {
                                                let ui_file = ReceivedFile {
                                                    sender_id,
                                                    sender_name,
                                                    file_path: saved_path,
                                                    file_name,
                                                    timestamp,
                                                    is_private,
                                                };
                                                let _ = app_clone.emit("file-received", ui_file);
                                            }
                                        }
                                    }
                                }
                            } else {
                                println!("Uyarı: Farklı oda parolalı veya bozuk paket reddedildi.");
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
    room_key: [u8; 32],
    packet: &NetworkPacket,
) -> Result<(), String> {
    let plaintext = serde_json::to_vec(packet).map_err(|e| e.to_string())?;
    let encrypted_payload = crypto::encrypt(&room_key, &plaintext)?;

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
