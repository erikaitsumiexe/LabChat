import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface Peer {
  id: string;
  username: string;
  ip: string;
  public_key?: number[];
  online?: boolean;
  is_muted?: boolean;
  avatar?: string | null;
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

export interface MessageRead {
  msg_ids: string[];
  sender_id: string;
}

export interface MessageStatus {
  msg_id: string;
  status: "queued" | "sent" | string;
}

export interface FilePreviewResponse {
  file_type: "image" | "text" | string;
  mime_type: string;
  content: string;
  file_size: number;
}

export interface AdminNotice {
  action: "ban" | "mute" | "unmute" | string;
  is_self?: boolean;
  target_id?: string;
  target_name?: string;
  reason?: string;
}

export interface TypingPayload {
  sender_id: string;
  sender_name: string;
  is_typing: boolean;
  is_private: boolean;
  avatar?: string | null;
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

  markAsRead: async (peerId: string, msgIds: string[]): Promise<void> => {
    await invoke("mark_as_read", { peerId, msgIds });
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

  setPeerMuted: async (peerId: string, isMuted: boolean): Promise<void> => {
    await invoke("set_peer_muted", { peerId, isMuted });
  },

  removePeer: async (peerId: string): Promise<void> => {
    await invoke("remove_peer", { peerId });
  },

  verifyAdminPassword: async (password: string): Promise<boolean> => {
    return await invoke<boolean>("verify_admin_password", { password });
  },

  adminModerateUser: async (
    adminPassword: string,
    targetId: string,
    action: "mute" | "unmute" | "ban"
  ): Promise<void> => {
    await invoke("admin_moderate_user", { adminPassword, targetId, action });
  },

  setAvatar: async (avatarBase64: string | null): Promise<void> => {
    await invoke("set_avatar", { avatarBase64 });
  },

  getMyAvatar: async (): Promise<string | null> => {
    return await invoke<string | null>("get_my_avatar");
  },

  sendTyping: async (targetId: string | null, isTyping: boolean): Promise<void> => {
    await invoke("send_typing", { targetId, isTyping });
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
  },

  onMessageRead: async (callback: (read: MessageRead) => void): Promise<UnlistenFn> => {
    return await listen<MessageRead>("message-read", (event) => {
      callback(event.payload);
    });
  },

  onMessageStatus: async (callback: (st: MessageStatus) => void): Promise<UnlistenFn> => {
    return await listen<MessageStatus>("message-status", (event) => {
      callback(event.payload);
    });
  },

  onAdminNotice: async (callback: (notice: AdminNotice) => void): Promise<UnlistenFn> => {
    return await listen<AdminNotice>("admin-notice", (event) => {
      callback(event.payload);
    });
  },

  onPeerTyping: async (callback: (payload: TypingPayload) => void): Promise<UnlistenFn> => {
    return await listen<TypingPayload>("peer-typing", (event) => {
      callback(event.payload);
    });
  },
};