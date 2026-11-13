use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;

mod crypto;
mod discovery;
mod transport;

// Uygulama boyunca hafızada tutacağımız veriler
struct AppState {
    my_id: Mutex<String>,
    room_key: Mutex<[u8; 32]>,
}

#[tauri::command]
async fn join_room(app: AppHandle, state: State<'_, AppState>, username: String, room_password: String) -> Result<(), String> {
    println!("Backend: {} giriş yaptı. Oda Parolası işleniyor...", username);
    
    let my_id = Uuid::new_v4().to_string();
    *state.my_id.lock().await = my_id.clone();
    
    // Paroladan Blake3 ile güvenli 32-byte AES/ChaCha anahtarı türet
    let key = crypto::derive_room_key(&room_password);
    *state.room_key.lock().await = key;

    // UDP Keşfini başlat
    discovery::start_discovery(app.clone(), my_id, username).await;
    
    // TCP Dinleyicisini (Mesaj Alımını) başlat
    transport::start_tcp_server(app, key).await;
    
    Ok(())
}

#[tauri::command]
async fn send_message(state: State<'_, AppState>, target_ip: String, text: String) -> Result<(), String> {
    let my_id = state.my_id.lock().await.clone();
    let key = *state.room_key.lock().await;

    // Şifreleyip hedefe fırlat
    transport::send_tcp_message(&target_ip, key, my_id, text).await
}

#[tauri::command]
async fn send_file(app: AppHandle, target_id: Option<String>, file_path: String) -> Result<(), String> {
    // TODO: Dosya chunking işlemleri buraya eklenecek
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
	.plugin(tauri_plugin_opener::init())
        // State yapısını Tauri'ye tanıtıyoruz ki komutlar erişebilsin
        .manage(AppState {
            my_id: Mutex::new(String::new()),
            room_key: Mutex::new([0u8; 32]),
        })
        .invoke_handler(tauri::generate_handler![
            join_room,
            send_message,
            send_file
        ])
        .run(tauri::generate_context!())
        .expect("Tauri backend motoru çöktü!");
}
