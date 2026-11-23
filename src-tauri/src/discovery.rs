use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, Duration};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Peer {
    pub id: String,
    pub username: String,
    pub ip: String,
    pub public_key: [u8; 32],
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub last_seen: u64,
    #[serde(default)]
    pub is_muted: bool,
}

#[derive(Serialize, Deserialize)]
struct AnnouncePacket {
    id: String,
    username: String,
    public_key: [u8; 32],
}

const DISCOVERY_PORT: u16 = 54321;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn peers_file_path() -> PathBuf {
    let dir = std::env::temp_dir().join("labchat_state");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("known_peers.json")
}

pub async fn load_known_peers() -> HashMap<String, Peer> {
    let path = peers_file_path();
    if let Ok(bytes) = fs::read(path).await {
        if let Ok(mut map) = serde_json::from_slice::<HashMap<String, Peer>>(&bytes) {
            for peer in map.values_mut() {
                peer.online = false;
            }
            return map;
        }
    }
    HashMap::new()
}

pub async fn save_known_peers(peers: &HashMap<String, Peer>) {
    if let Ok(json) = serde_json::to_vec_pretty(peers) {
        let _ = fs::write(peers_file_path(), json).await;
    }
}

fn get_broadcast_targets() -> Vec<String> {
    let mut targets = vec![format!("255.255.255.255:{}", DISCOVERY_PORT)];
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(std::net::SocketAddr::V4(addr)) = sock.local_addr() {
                let octets = addr.ip().octets();
                let subnet_bcast = format!("{}.{}.{}.255:{}", octets[0], octets[1], octets[2], DISCOVERY_PORT);
                if !targets.contains(&subnet_bcast) {
                    targets.push(subnet_bcast);
                }
            }
        }
    }
    targets
}

pub async fn start_discovery(
    app: AppHandle,
    my_id: String,
    my_username: String,
    my_public_key: [u8; 32],
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    banned_ids: Arc<Mutex<HashSet<String>>>,
    globally_muted_ids: Arc<Mutex<HashSet<String>>>,
    locally_muted_ids: Arc<Mutex<HashSet<String>>>,
    online_tx: mpsc::UnboundedSender<Peer>,
) {
    let initial_peers = load_known_peers().await;
    if !initial_peers.is_empty() {
        let banned = banned_ids.lock().await;
        let mut p_map = peers.lock().await;
        for (k, v) in initial_peers {
            if k != my_id && !banned.contains(&k) {
                p_map.insert(k, v);
            }
        }
        let peer_list: Vec<Peer> = p_map.values().cloned().collect();
        let _ = app.emit("peers-updated", peer_list);
    }

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
    let banned_clone = banned_ids.clone();
    let g_muted_clone = globally_muted_ids.clone();
    let l_muted_clone = locally_muted_ids.clone();
    let app_clone = app.clone();
    let my_id_clone = my_id.clone();

    tokio::spawn(async move {
        let mut buf = [0; 2048];
        loop {
            if let Ok((len, addr)) = listen_socket.recv_from(&mut buf).await {
                if let Ok(packet) = serde_json::from_slice::<AnnouncePacket>(&buf[..len]) {
                    if packet.id != my_id_clone {
                        if banned_clone.lock().await.contains(&packet.id) {
                            continue;
                        }

                        let is_muted = g_muted_clone.lock().await.contains(&packet.id)
                            || l_muted_clone.lock().await.contains(&packet.id);

                        let mut p_map = peers_clone.lock().await;
                        let peer_ip = addr.ip().to_string();
                        let current_ts = now_secs();

                        let (should_emit, became_online) = match p_map.get(&packet.id) {
                            Some(existing) => {
                                let changed = existing.username != packet.username
                                    || existing.ip != peer_ip
                                    || existing.public_key != packet.public_key
                                    || existing.is_muted != is_muted
                                    || !existing.online;
                                (changed, !existing.online)
                            }
                            None => (true, true),
                        };

                        let peer_obj = Peer {
                            id: packet.id.clone(),
                            username: packet.username,
                            ip: peer_ip,
                            public_key: packet.public_key,
                            online: true,
                            last_seen: current_ts,
                            is_muted,
                        };

                        p_map.insert(packet.id, peer_obj.clone());

                        if should_emit {
                            let peer_list: Vec<Peer> = p_map.values().cloned().collect();
                            let _ = app_clone.emit("peers-updated", peer_list);
                            save_known_peers(&p_map).await;
                        }

                        if became_online {
                            let _ = online_tx.send(peer_obj);
                        }
                    }
                }
            }
        }
    });

    let peers_watchdog = peers.clone();
    let app_watchdog = app.clone();
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(4)).await;
            let current_ts = now_secs();
            let mut p_map = peers_watchdog.lock().await;
            let mut changed = false;

            for peer in p_map.values_mut() {
                if peer.online && current_ts.saturating_sub(peer.last_seen) > 10 {
                    peer.online = false;
                    changed = true;
                }
            }

            if changed {
                let peer_list: Vec<Peer> = p_map.values().cloned().collect();
                let _ = app_watchdog.emit("peers-updated", peer_list);
                save_known_peers(&p_map).await;
            }
        }
    });

    tokio::spawn(async move {
        let announce = AnnouncePacket {
            id: my_id,
            username: my_username,
            public_key: my_public_key,
        };
        let msg = serde_json::to_string(&announce).unwrap();
        loop {
            for target in get_broadcast_targets() {
                let _ = send_socket.send_to(msg.as_bytes(), &target).await;
            }
            sleep(Duration::from_secs(3)).await;
        }
    });
}
