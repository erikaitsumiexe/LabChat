import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// --- TİP TANIMLAMALARI ---
export interface Peer {
  id: string;
  username: string;
  ip: string;
}

export interface ReceivedMessage {
  sender_id: string;
  text: string;
  timestamp: string;
}

export interface ReceivedFile {
  sender_id: string;
  file_path: string;
  file_name: string;
}

// --- KÖPRÜ (BRIDGE) OBJESİ ---
export const bridge = {
  // 1. Odaya Katılma
  joinRoom: async (username: string, roomPassword: string): Promise<void> => {
    // Backend sözleşmesine uygun parametreler (roomPassword)
    await invoke('join_room', { username, roomPassword });
  },

  // 2. Mesaj Gönderme (targetIp null ise herkese (broadcast) gider)
  sendMessage: async (targetIp: string | null, text: string): Promise<void> => {
    // Backend sözleşmesine uygun parametreler (targetIp)
    await invoke('send_message', { targetIp, text });
  },

  // 3. Dosya Gönderme
  sendFile: async (targetId: string | null, filePath: string): Promise<void> => {
    // Backend sözleşmesine uygun parametreler (targetId, filePath)
    await invoke('send_file', { targetId, filePath });
  },

  // 4. Ağdaki Peer'leri Dinleme
  onPeersUpdated: async (callback: (peers: Peer[]) => void): Promise<UnlistenFn> => {
    return await listen<Peer[]>('peers-updated', (event) => {
      callback(event.payload);
    });
  },

  // 5. Gelen Mesajları Dinleme
  onMessageReceived: async (callback: (msg: ReceivedMessage) => void): Promise<UnlistenFn> => {
    return await listen<ReceivedMessage>('message-received', (event) => {
      callback(event.payload);
    });
  },

  // 6. Gelen Dosyaları Dinleme
  onFileReceived: async (callback: (file: ReceivedFile) => void): Promise<UnlistenFn> => {
    return await listen<ReceivedFile>('file-received', (event) => {
      callback(event.payload);
    });
  }
};