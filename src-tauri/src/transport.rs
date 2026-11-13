use crate::crypto::{self, CryptoSession};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TCP_PORT: u16 = 54322;

// Ağda şifrelenmeden ÖNCEKİ düz mesaj yapımız
#[derive(Serialize, Deserialize, Clone)]
pub struct MessagePayload {
    pub sender_id: String,
    pub text: String,
    pub timestamp: u64,
}

// Frontend'e fırlatılacak event yapısı
#[derive(Clone, Serialize)]
pub struct ReceivedMessage {
    pub sender_id: String,
    pub text: String,
    pub timestamp: u64,
}

// 1. TCP SUNUCUSU (Gelen Mesajları Dinler)
pub async fn start_tcp_server(app: AppHandle, room_key: [u8; 32]) {
    let listener = TcpListener::bind(format!("0.0.0.0:{}", TCP_PORT))
        .await
        .expect("TCP Portu dinlenemiyor!");

    tokio::spawn(async move {
        loop {
            if let Ok((mut socket, _addr)) = listener.accept().await {
                let app_clone = app.clone();
                let key_clone = room_key; // Oda parolasından türetilmiş anahtar

                tokio::spawn(async move {
                    // Bağlantı geldiğinde önce 4 baytlık paket boyutunu oku
                    let mut length_buf = [0u8; 4];
                    if socket.read_exact(&mut length_buf).await.is_ok() {
                        let payload_len = u32::from_be_bytes(length_buf) as usize;
                        let mut encrypted_buf = vec![0u8; payload_len];
                        
                        // Şifreli paketin tamamını oku
                        if socket.read_exact(&mut encrypted_buf).await.is_ok() {
                            // ChaCha20-Poly1305 ile şifreyi çöz ve bütünlüğü doğrula
                            if let Ok(decrypted_bytes) = crypto::decrypt(&key_clone, &encrypted_buf) {
                                // JSON'ı parçala
                                if let Ok(msg) = serde_json::from_slice::<MessagePayload>(&decrypted_bytes) {
                                    // Arayüze "message-received" event'i fırlat
                                    let ui_msg = ReceivedMessage {
                                        sender_id: msg.sender_id,
                                        text: msg.text,
                                        timestamp: msg.timestamp,
                                    };
                                    let _ = app_clone.emit("message-received", ui_msg);
                                }
                            } else {
                                println!("Dikkat: Şifresi çözülemeyen veya bozuk paket alındı!");
                            }
                        }
                    }
                });
            }
        }
    });
}

// 2. TCP İSTEMCİSİ (Mesaj Gönderir)
pub async fn send_tcp_message(target_ip: &str, room_key: [u8; 32], sender_id: String, text: String) -> Result<(), String> {
    let payload = MessagePayload {
        sender_id,
        text,
        timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
    };
    
    // JSON'a çevir
    let plaintext = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    
    // ChaCha20-Poly1305 ile şifrele
    let encrypted_payload = crypto::encrypt(&room_key, &plaintext)?;
    
    // Hedef IP'ye bağlan (Örn: 192.168.1.55:54322)
    let mut stream = TcpStream::connect(format!("{}:{}", target_ip, TCP_PORT))
        .await
        .map_err(|e| e.to_string())?;

    // Önce boyut bilgisini (4 bayt), sonra şifreli veriyi yolla
    let len_bytes = (encrypted_payload.len() as u32).to_be_bytes();
    stream.write_all(&len_bytes).await.map_err(|e| e.to_string())?;
    stream.write_all(&encrypted_payload).await.map_err(|e| e.to_string())?;

    Ok(())
}
