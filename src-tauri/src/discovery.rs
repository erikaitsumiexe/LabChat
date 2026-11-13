use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Peer {
    pub id: String,
    pub username: String,
    pub ip: String,
}

#[derive(Serialize, Deserialize)]
struct AnnouncePacket {
    id: String,
    username: String,
}

const DISCOVERY_PORT: u16 = 54321;

pub async fn start_discovery(
    app: AppHandle,
    my_id: String,
    my_username: String,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
) {
    let listen_socket = UdpSocket::bind(format!("0.0.0.0:{}", DISCOVERY_PORT))
        .await
        .expect("UDP Keşif portu (54321) dolu!");
    let send_socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .expect("UDP Gönderim soketi açılamadı!");
    send_socket
        .set_broadcast(true)
        .expect("Broadcast izni alınamadı!");

    let peers_clone = peers.clone();
    let app_clone = app.clone();
    let my_id_clone = my_id.clone();

    tokio::spawn(async move {
        let mut buf = [0; 1024];
        loop {
            if let Ok((len, addr)) = listen_socket.recv_from(&mut buf).await {
                if let Ok(packet) = serde_json::from_slice::<AnnouncePacket>(&buf[..len]) {
                    if packet.id != my_id_clone {
                        let mut p_map = peers_clone.lock().await;
                        let peer_ip = addr.ip().to_string();
                        let should_emit = match p_map.get(&packet.id) {
                            Some(existing) => {
                                existing.username != packet.username || existing.ip != peer_ip
                            }
                            None => true,
                        };

                        p_map.insert(
                            packet.id.clone(),
                            Peer {
                                id: packet.id,
                                username: packet.username,
                                ip: peer_ip,
                            },
                        );

                        if should_emit {
                            let peer_list: Vec<Peer> = p_map.values().cloned().collect();
                            let _ = app_clone.emit("peers-updated", peer_list);
                        }
                    }
                }
            }
        }
    });

    tokio::spawn(async move {
        let announce = AnnouncePacket {
            id: my_id,
            username: my_username,
        };
        let msg = serde_json::to_string(&announce).unwrap();
        loop {
            let _ = send_socket
                .send_to(msg.as_bytes(), format!("255.255.255.255:{}", DISCOVERY_PORT))
                .await;
            sleep(Duration::from_secs(3)).await;
        }
    });
}
