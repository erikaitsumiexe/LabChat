import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface Peer {
  id: string;
  username: string;
  ip: string;
  public_key?: number[];
}

export interface ReceivedMessage {
  msg_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  timestamp: string;
  is_private: boolean;
}

export interface ReceivedFile {
  msg_id: string;
  sender_id: string;
  sender_name: string;
  file_path: string;
  file_name: string;
  timestamp: string;
  is_private: boolean;
}

export interface MessageAck {
  msg_id: string;
  sender_id: string;
}

export interface FilePreviewResponse {
  file_type: "image" | "text" | string;
  mime_type: string;
  content: string;
  file_size: number;
}

export const bridge = {
  joinRoom: async (username: string, roomPassword: string): Promise<void> => {
    await invoke("join_room", { username, roomPassword });
  },

  sendMessage: async (targetId: string | null, text: string): Promise<string> => {
    return await invoke<string>("send_message", { targetId, text });
  },

  sendFile: async (targetId: string | null, filePath: string): Promise<string> => {
    return await invoke<string>("send_file", { targetId, filePath });
  },

  readFilePreview: async (filePath: string): Promise<FilePreviewResponse> => {
    return await invoke<FilePreviewResponse>("read_file_preview", { filePath });
  },

  sendClipboardImage: async (
    targetId: string | null,
    fileName: string,
    base64Data: string
  ): Promise<string> => {
    return await invoke<string>("send_clipboard_image", {
      targetId,
      fileName,
      base64Data,
    });
  },

  onPeersUpdated: async (callback: (peers: Peer[]) => void): Promise<UnlistenFn> => {
    return await listen<Peer[]>("peers-updated", (event) => {
      callback(event.payload);
    });
  },

  onMessageReceived: async (callback: (msg: ReceivedMessage) => void): Promise<UnlistenFn> => {
    return await listen<ReceivedMessage>("message-received", (event) => {
      callback(event.payload);
    });
  },

  onFileReceived: async (callback: (file: ReceivedFile) => void): Promise<UnlistenFn> => {
    return await listen<ReceivedFile>("file-received", (event) => {
      callback(event.payload);
    });
  },

  onMessageAck: async (callback: (ack: MessageAck) => void): Promise<UnlistenFn> => {
    return await listen<MessageAck>("message-ack", (event) => {
      callback(event.payload);
    });
  }
};
