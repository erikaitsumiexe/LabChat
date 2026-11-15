import {
  useState,
  useEffect,
  useRef,
  FormEvent,
  MouseEvent,
  KeyboardEvent as ReactKeyboardEvent
} from 'react';
import {
  Shield,
  ShieldAlert,
  Users,
  Send,
  Paperclip,
  Lock,
  Wifi,
  Key,
  X,
  Hash,
  MessageSquare,
  Copy,
  Check,
  CheckCheck,
  FileText,
  ArrowUpRight,
  ArrowDownLeft,
  LogOut,
  Clock,
  Terminal,
  Search,
  UploadCloud,
  Command,
  Eye,
  ZoomIn,
  ZoomOut,
  Loader2,
  AlertCircle,
  Image as ImageIcon,
  MoreVertical,
  BellOff,
  Bell,
  Trash2,
  Ban,
  VolumeX,
  Volume2
} from 'lucide-react';
import { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { bridge, Peer, FilePreviewResponse } from './services/bridge';

type MessageDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read';

interface ExtendedPeer extends Peer {
  is_muted?: boolean;
}

interface AdminNoticePayload {
  action: 'ban' | 'mute' | 'unmute';
  is_self?: boolean;
  target_id?: string;
  target_name?: string;
  reason?: string;
}

interface PeerContextMenuState {
  peer: ExtendedPeer;
  x: number;
  y: number;
}

interface ChatTab {
  id: string;
  title: string;
  isGroup: boolean;
  hasUnread: boolean;
}

interface FileAttachment {
  fileName: string;
  filePath: string;
  direction: 'sent' | 'received';
}

interface ChatMessage {
  id: string;
  backendMsgId?: string;
  sender_id: string;
  sender_name: string;
  text: string;
  timestamp: string;
  isMine: boolean;
  isPrivate?: boolean;
  status?: MessageDeliveryStatus;
  isSystem?: boolean;
  file?: FileAttachment;
}

interface IncomingMessagePayload {
  msg_id?: string;
  id?: string;
  sender_id: string;
  sender_name?: string;
  text: string;
  timestamp: string;
  is_private?: boolean;
}

interface IncomingFilePayload {
  msg_id?: string;
  id?: string;
  sender_id: string;
  sender_name?: string;
  file_path: string;
  file_name: string;
  timestamp?: string;
  is_private?: boolean;
}

interface MessageStatusPayload {
  msg_id: string;
  status: 'queued' | 'sent';
}

interface MessageAckPayload {
  msg_id: string;
  sender_id?: string;
}

interface MessageReadPayload {
  msg_ids: string[];
  sender_id?: string;
}

interface QuickActionItem {
  id: string;
  label: string;
  sublabel: string;
  category: 'Sekmeler' | 'Cihazlar' | 'Komutlar';
  onSelect: () => void;
}

interface PendingClipboardImage {
  fileName: string;
  base64Data: string;
  sizeKB: number;
}

interface PreviewModalState {
  fileName: string;
  filePath: string;
  loading: boolean;
  error: string | null;
  data: FilePreviewResponse | null;
}

const GROUP_TAB_ID = 'group';
const PREVIEWABLE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'txt',
  'log',
  'md',
  'json',
  'csv',
  'xml',
  'yml',
  'yaml'
];

function isPreviewableFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return PREVIEWABLE_EXTENSIONS.includes(ext);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUptime(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

function isCodeMessage(text: string): boolean {
  return (
    text.includes('\n') ||
    text.includes('```') ||
    (text.startsWith('`') && text.endsWith('`') && text.length > 2)
  );
}

function cleanCodeContent(text: string): string {
  if (text.startsWith('```') && text.endsWith('```')) {
    return text.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '');
  }
  if (text.startsWith('`') && text.endsWith('`')) {
    return text.slice(1, -1);
  }
  return text;
}

function mergeMessageStatus(
  current: MessageDeliveryStatus | undefined,
  incoming: MessageDeliveryStatus
): MessageDeliveryStatus {
  if (current === 'read' || incoming === 'read') return 'read';
  if (current === 'delivered' || incoming === 'delivered') return 'delivered';
  return incoming;
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [peers, setPeers] = useState<ExtendedPeer[]>([]);
  const [tabs, setTabs] = useState<ChatTab[]>([
    { id: GROUP_TAB_ID, title: 'Genel Kanal', isGroup: true, hasUnread: false }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(GROUP_TAB_ID);
  const [histories, setHistories] = useState<Record<string, ChatMessage[]>>({
    [GROUP_TAB_ID]: []
  });
  const [inputText, setInputText] = useState('');

  // Sürükle-Bırak ve Ctrl+K Komut Paleti State'leri
  const [isDragging, setIsDragging] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Ctrl+V Pano Görseli ve Dosya Okuyucu Modal State'leri
  const [pendingImage, setPendingImage] = useState<PendingClipboardImage | null>(null);
  const [isSendingImage, setIsSendingImage] = useState(false);
  const [previewModal, setPreviewModal] = useState<PreviewModalState | null>(null);
  const [imageZoomed, setImageZoomed] = useState(false);

  // Ağdaki Cihazlar Üç Nokta / Sağ Tık Menüsü State'i
  const [peerMenu, setPeerMenu] = useState<PeerContextMenuState | null>(null);

  // Admin Paneli ve Moderasyon State'leri
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [verifiedAdminPassword, setVerifiedAdminPassword] = useState<string | null>(null);
  const [adminAuthError, setAdminAuthError] = useState<string | null>(null);
  const [isVerifyingAdmin, setIsVerifyingAdmin] = useState(false);
  const [moderatingPeerId, setModeratingPeerId] = useState<string | null>(null);
  const [isSelfMuted, setIsSelfMuted] = useState(false);

  const activeTabRef = useRef<string>(GROUP_TAB_ID);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);

  // Event'lerin invoke dönüşünden önce gelme ihtimaline karşı durum tamponu
  const earlyStatusMapRef = useRef(new Map());
  // Aynı mesaj için tekrar markAsRead çağrılmasını önleyen takip kümesi
  const sentReadReceiptsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    activeTabRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [histories, activeTabId]);

  // --- AÇIK KİŞİ MENÜSÜNÜ DIŞARI TIKLANINCA KAPAT ---
  useEffect(() => {
    if (!peerMenu) return;

    const handleGlobalClick = () => setPeerMenu(null);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, [peerMenu]);

  // --- AKTİF DM SEKMESİNDE OKUNMAMIŞ MESAJLAR İÇİN MARK_AS_READ TETİKLEYİCİSİ ---
  useEffect(() => {
    if (!isLoggedIn || activeTabId === GROUP_TAB_ID) return;

    const activeMessages = histories[activeTabId] || [];
    const unreadMsgIds = activeMessages
      .filter(
        (m) =>
          !m.isMine &&
          !m.isSystem &&
          Boolean(m.backendMsgId) &&
          !sentReadReceiptsRef.current.has(m.backendMsgId!)
      )
      .map((m) => m.backendMsgId!);

    if (unreadMsgIds.length === 0) return;

    unreadMsgIds.forEach((id) => sentReadReceiptsRef.current.add(id));

    bridge.markAsRead(activeTabId, unreadMsgIds).catch((err) => {
      console.error('markAsRead gönderilemedi:', err);
      unreadMsgIds.forEach((id) => sentReadReceiptsRef.current.delete(id));
    });
  }, [isLoggedIn, activeTabId, histories]);

  // --- CANLI OTURUM SAYACI (UPTIME) ---
  useEffect(() => {
    if (!isLoggedIn) {
      setUptimeSeconds(0);
      return;
    }

    const timer = setInterval(() => {
      setUptimeSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isLoggedIn]);

  // --- KLAVYE KISAYOLLARI (CTRL+K, ESC) ---
  useEffect(() => {
    if (!isLoggedIn) return;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsPaletteOpen((prev) => !prev);
        setPaletteQuery('');
        setSelectedIndex(0);
      } else if (e.key === 'Escape') {
        if (peerMenu) {
          setPeerMenu(null);
        } else if (isAdminModalOpen) {
          setIsAdminModalOpen(false);
        } else if (previewModal) {
          setPreviewModal(null);
        } else if (isPaletteOpen) {
          setIsPaletteOpen(false);
        } else if (pendingImage) {
          setPendingImage(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLoggedIn, peerMenu, isAdminModalOpen, previewModal, isPaletteOpen, pendingImage]);

  useEffect(() => {
    if (isPaletteOpen) {
      setTimeout(() => paletteInputRef.current?.focus(), 20);
    }
  }, [isPaletteOpen]);

  // --- CTRL + V PANO (CLIPBOARD) EKRAN GÖRÜNTÜSÜ YAKALAMA ---
  const processClipboardItems = (items: DataTransferItemList | undefined): boolean => {
    if (!items) return false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const now = new Date();
          const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
            now.getDate()
          ).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(
            now.getMinutes()
          ).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
          const ext = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';

          setPendingImage({
            fileName: `screenshot_${stamp}.${ext}`,
            base64Data: result,
            sizeKB: Math.max(1, Math.round(blob.size / 1024))
          });
          setTimeout(() => messageInputRef.current?.focus(), 20);
        };
        reader.readAsDataURL(blob);
        return true;
      }
    }
    return false;
  };

  useEffect(() => {
    if (!isLoggedIn) return;

    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (isPaletteOpen || previewModal || isAdminModalOpen) return;
      const handled = processClipboardItems(e.clipboardData?.items);
      if (handled) {
        e.preventDefault();
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [isLoggedIn, isPaletteOpen, previewModal, isAdminModalOpen]);

  // --- MASAÜSTÜ BİLDİRİM YARDIMCISI ---
  const triggerDesktopNotification = (title: string, body: string, targetTabId: string) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (document.hasFocus()) return;

    const showNotif = () => {
      const notif = new Notification(title, { body });
      notif.onclick = () => {
        window.focus();
        setActiveTabId(targetTabId);
        setTabs((prev) =>
          prev.map((t) => (t.id === targetTabId ? { ...t, hasUnread: false } : t))
        );
        notif.close();
      };
    };

    if (Notification.permission === 'granted') {
      showNotif();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') showNotif();
      });
    }
  };

  // --- ORTAK DOSYA GÖNDERİM YARDIMCISI (ATAÇ + SÜRÜKLE BIRAK) ---
  const dispatchFileToTarget = async (filePath: string, customTargetTabId?: string) => {
    const tabId = customTargetTabId || activeTabRef.current;
    const targetId = tabId === GROUP_TAB_ID ? null : tabId;
    const fileName = filePath.split(/[/\\]/).pop() || filePath;

    const msgId = await bridge.sendFile(targetId, filePath);
    const resolvedId = msgId || crypto.randomUUID();

    const bufferedStatus = earlyStatusMapRef.current.get(resolvedId);
    if (bufferedStatus) {
      earlyStatusMapRef.current.delete(resolvedId);
    }

    const fileMsg: ChatMessage = {
      id: resolvedId,
      sender_id: 'me',
      sender_name: username,
      text: fileName,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      isMine: true,
      status: bufferedStatus || 'sent',
      file: {
        fileName,
        filePath,
        direction: 'sent'
      }
    };

    setHistories((prev) => ({
      ...prev,
      [tabId]: [...(prev[tabId] || []), fileMsg]
    }));
  };

  // --- TAURI SÜRÜKLE-BIRAK (DRAG & DROP) DİNLEYİCİSİ ---
  useEffect(() => {
    if (!isLoggedIn) return;

    let unlistenDragDrop: UnlistenFn | undefined;

    const setupDragDrop = async () => {
      try {
        unlistenDragDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            setIsDragging(true);
          } else if (payload.type === 'leave') {
            setIsDragging(false);
          } else if (payload.type === 'drop') {
            setIsDragging(false);
            if (payload.paths && payload.paths.length > 0) {
              for (const filePath of payload.paths) {
                try {
                  await dispatchFileToTarget(filePath);
                } catch (err) {
                  console.error('Sürükle-bırak dosya gönderim hatası:', err);
                }
              }
            }
          }
        });
      } catch (err) {
        console.error('Drag-drop dinleyicisi başlatılamadı:', err);
      }
    };

    setupDragDrop();

    return () => {
      if (unlistenDragDrop) unlistenDragDrop();
    };
  }, [isLoggedIn, username]);

  // --- EVENT LİSTENER KURULUMU (PEERS, MESSAGES, FILES, STATUS, ACK, READ, ADMIN NOTICE) ---
  useEffect(() => {
    if (!isLoggedIn) return;

    let unlistenPeers: UnlistenFn | undefined;
    let unlistenMessages: UnlistenFn | undefined;
    let unlistenFiles: UnlistenFn | undefined;
    let unlistenStatus: UnlistenFn | undefined;
    let unlistenAck: UnlistenFn | undefined;
    let unlistenRead: UnlistenFn | undefined;
    let unlistenAdminNotice: UnlistenFn | undefined;

    const applyStatusUpdates = (updates: Array<{ msgId: string; status: MessageDeliveryStatus }>) => {
      if (updates.length === 0) return;

      const updateMap = new Map<string, MessageDeliveryStatus>();
      for (const item of updates) {
        if (!item.msgId) continue;
        const prevBuffered = earlyStatusMapRef.current.get(item.msgId);
        const merged = mergeMessageStatus(prevBuffered, item.status);
        earlyStatusMapRef.current.set(item.msgId, merged);
        updateMap.set(item.msgId, merged);
      }

      setHistories((prev) => {
        let changed = false;
        const nextHistories: Record<string, ChatMessage[]> = {};

        for (const [tabId, tabMessages] of Object.entries(prev)) {
          let tabChanged = false;
          const nextMessages = tabMessages.map((m) => {
            const incomingStatus = updateMap.get(m.id);
            if (!incomingStatus) return m;

            earlyStatusMapRef.current.delete(m.id);
            const nextStatus = mergeMessageStatus(m.status, incomingStatus);
            if (nextStatus === m.status) return m;

            tabChanged = true;
            changed = true;
            return { ...m, status: nextStatus };
          });

          nextHistories[tabId] = tabChanged ? nextMessages : tabMessages;
        }

        return changed ? nextHistories : prev;
      });
    };

    const handleIncomingItem = (
      targetTabId: string,
      tabTitle: string,
      isPrivate: boolean,
      newMsg: ChatMessage,
      notifTitle: string,
      notifBody: string
    ) => {
      setTabs((prevTabs) => {
        const exists = prevTabs.some((t) => t.id === targetTabId);
        const isCurrentlyActive = activeTabRef.current === targetTabId;

        if (!exists && isPrivate) {
          return [
            ...prevTabs,
            {
              id: targetTabId,
              title: tabTitle,
              isGroup: false,
              hasUnread: !isCurrentlyActive
            }
          ];
        }

        return prevTabs.map((t) =>
          t.id === targetTabId
            ? { ...t, hasUnread: isCurrentlyActive ? false : true }
            : t
        );
      });

      setHistories((prev) => ({
        ...prev,
        [targetTabId]: [...(prev[targetTabId] || []), newMsg]
      }));

      triggerDesktopNotification(notifTitle, notifBody, targetTabId);
    };

    const setupListeners = async () => {
      try {
        unlistenPeers = await bridge.onPeersUpdated((updatedPeers) => {
          setPeers(updatedPeers as ExtendedPeer[]);
          setTabs((prevTabs) =>
            prevTabs.map((tab) => {
              if (tab.isGroup) return tab;
              const matchedPeer = updatedPeers.find((p) => p.id === tab.id);
              return matchedPeer ? { ...tab, title: matchedPeer.username } : tab;
            })
          );
        });

        unlistenMessages = await bridge.onMessageReceived((rawMsg) => {
          const msg = rawMsg as unknown as IncomingMessagePayload;
          const isPrivate = Boolean(msg.is_private);
          const targetTabId = isPrivate ? msg.sender_id : GROUP_TAB_ID;
          const displayName = msg.sender_name || msg.sender_id;
          const backendMsgId = msg.msg_id || msg.id;

          handleIncomingItem(
            targetTabId,
            displayName,
            isPrivate,
            {
              id: backendMsgId || crypto.randomUUID(),
              backendMsgId,
              sender_id: msg.sender_id,
              sender_name: displayName,
              text: msg.text,
              timestamp:
                msg.timestamp ||
                new Date().toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                }),
              isMine: false,
              isPrivate
            },
            isPrivate ? `LabChat • @${displayName}` : `LabChat • Genel Kanal (${displayName})`,
            msg.text
          );
        });

        unlistenFiles = await bridge.onFileReceived((rawFile) => {
          const file = rawFile as unknown as IncomingFilePayload;
          const isPrivate = Boolean(file.is_private);
          const targetTabId = isPrivate ? file.sender_id : GROUP_TAB_ID;
          const displayName = file.sender_name || file.sender_id;
          const backendMsgId = file.msg_id || file.id;

          handleIncomingItem(
            targetTabId,
            displayName,
            isPrivate,
            {
              id: backendMsgId || crypto.randomUUID(),
              backendMsgId,
              sender_id: file.sender_id,
              sender_name: displayName,
              text: file.file_name,
              timestamp:
                file.timestamp ||
                new Date().toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                }),
              isMine: false,
              isPrivate,
              file: {
                fileName: file.file_name,
                filePath: file.file_path,
                direction: 'received'
              }
            },
            isPrivate
              ? `LabChat • @${displayName} dosya gönderdi`
              : `LabChat • Genel Kanala Dosya Geldi`,
            file.file_name
          );
        });

        unlistenStatus = await bridge.onMessageStatus((rawStatus) => {
          const payload = rawStatus as unknown as MessageStatusPayload;
          if (!payload?.msg_id || !payload?.status) return;
          applyStatusUpdates([{ msgId: payload.msg_id, status: payload.status }]);
        });

        unlistenAck = await bridge.onMessageAck((rawAck) => {
          const payload = rawAck as unknown as MessageAckPayload;
          if (!payload?.msg_id) return;
          applyStatusUpdates([{ msgId: payload.msg_id, status: 'delivered' }]);
        });

        unlistenRead = await bridge.onMessageRead((rawRead) => {
          const payload = rawRead as unknown as MessageReadPayload;
          if (!payload?.msg_ids || !Array.isArray(payload.msg_ids)) return;
          applyStatusUpdates(
            payload.msg_ids.map((id) => ({ msgId: id, status: 'read' as const }))
          );
        });

        if (typeof bridge.onAdminNotice === 'function') {
          unlistenAdminNotice = await bridge.onAdminNotice((rawNotice) => {
            const notice = rawNotice as unknown as AdminNoticePayload;
            if (!notice) return;

            if (notice.is_self) {
              if (notice.action === 'ban') {
                alert('Admin tarafından odadan yasaklandınız');
                handleDisconnect();
                return;
              }
              if (notice.action === 'mute') {
                setIsSelfMuted(true);
              } else if (notice.action === 'unmute') {
                setIsSelfMuted(false);
              }
            }
          });
        }
      } catch (error) {
        console.error('Listener başlatılırken hata oluştu:', error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenPeers) unlistenPeers();
      if (unlistenMessages) unlistenMessages();
      if (unlistenFiles) unlistenFiles();
      if (unlistenStatus) unlistenStatus();
      if (unlistenAck) unlistenAck();
      if (unlistenRead) unlistenRead();
      if (unlistenAdminNotice) unlistenAdminNotice();
    };
  }, [isLoggedIn]);

  // --- KİŞİ YÖNETİMİ AKSİYONLARI (SUSTUR / SİL) ---
  const handleOpenPeerMenu = (e: MouseEvent, peer: ExtendedPeer) => {
    e.preventDefault();
    e.stopPropagation();

    const menuWidth = 208;
    const menuHeight = 104;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12);

    setPeerMenu({ peer, x, y });
  };

  const handleTogglePeerMute = async (peer: ExtendedPeer) => {
    const nextMuted = !peer.is_muted;
    setPeerMenu(null);

    try {
      await bridge.setPeerMuted(peer.id, nextMuted);
      setPeers((prev) =>
        prev.map((p) => (p.id === peer.id ? { ...p, is_muted: nextMuted } : p))
      );
    } catch (err) {
      console.error('Susturma durumu güncellenemedi:', err);
      alert('Kullanıcı susturma durumu değiştirilemedi.');
    }
  };

  const handleRemovePeer = async (peer: ExtendedPeer) => {
    setPeerMenu(null);

    try {
      await bridge.removePeer(peer.id);

      setPeers((prev) => prev.filter((p) => p.id !== peer.id));
      setHistories((prev) => {
        const next = { ...prev };
        delete next[peer.id];
        return next;
      });
      setTabs((prev) => prev.filter((t) => t.id !== peer.id));

      if (activeTabId === peer.id) {
        setActiveTabId(GROUP_TAB_ID);
        setTabs((prev) =>
          prev.map((t) => (t.id === GROUP_TAB_ID ? { ...t, hasUnread: false } : t))
        );
      }
    } catch (err) {
      console.error('Kişi ve sohbet silinemedi:', err);
      alert('Kişi silinirken bir hata oluştu.');
    }
  };

  // --- ADMIN PANELİ AKSİYONLARI ---
  const handleOpenAdminModal = () => {
    setAdminAuthError(null);
    setAdminPasswordInput('');
    setIsAdminModalOpen(true);
  };

  const handleVerifyAdmin = async (e: FormEvent) => {
    e.preventDefault();
    if (!adminPasswordInput.trim() || isVerifyingAdmin) return;

    setIsVerifyingAdmin(true);
    setAdminAuthError(null);

    try {
      const isValid = await bridge.verifyAdminPassword(adminPasswordInput);
      if (isValid) {
        setVerifiedAdminPassword(adminPasswordInput);
        setAdminPasswordInput('');
      } else {
        setAdminAuthError('Hatalı admin şifresi. Lütfen tekrar deneyin.');
      }
    } catch (err) {
      setAdminAuthError(
        typeof err === 'string' ? err : 'Admin şifresi doğrulanırken hata oluştu.'
      );
    } finally {
      setIsVerifyingAdmin(false);
    }
  };

  const handleAdminModerate = async (
    targetPeer: ExtendedPeer,
    action: 'mute' | 'unmute' | 'ban'
  ) => {
    if (!verifiedAdminPassword || moderatingPeerId) return;

    setModeratingPeerId(targetPeer.id);
    try {
      await bridge.adminModerateUser(verifiedAdminPassword, targetPeer.id, action);

      if (action === 'ban') {
        setPeers((prev) => prev.filter((p) => p.id !== targetPeer.id));
        setTabs((prev) => prev.filter((t) => t.id !== targetPeer.id));
        setHistories((prev) => {
          const next = { ...prev };
          delete next[targetPeer.id];
          return next;
        });
        if (activeTabId === targetPeer.id) {
          setActiveTabId(GROUP_TAB_ID);
        }
      } else {
        const nextMuted = action === 'mute';
        setPeers((prev) =>
          prev.map((p) => (p.id === targetPeer.id ? { ...p, is_muted: nextMuted } : p))
        );
      }
    } catch (err) {
      console.error('Admin moderasyon işlemi başarısız:', err);
      alert(typeof err === 'string' ? err : 'Moderasyon işlemi uygulanamadı.');
    } finally {
      setModeratingPeerId(null);
    }
  };

  // --- DOSYA ÖNİZLEME / OKUYUCU AÇMA ---
  const handleOpenFilePreview = async (file: FileAttachment) => {
    setImageZoomed(false);
    setPreviewModal({
      fileName: file.fileName,
      filePath: file.filePath,
      loading: true,
      error: null,
      data: null
    });

    try {
      const response = await bridge.readFilePreview(file.filePath);
      setPreviewModal((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              data: response
            }
          : null
      );
    } catch (err) {
      setPreviewModal((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error:
                typeof err === 'string'
                  ? err
                  : 'Dosya içeriği okunamadı. Dosya yolunu kontrol edin.'
            }
          : null
      );
    }
  };

  // --- KOPYALAMA YARDIMCISI ---
  const handleCopy = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch (err) {
      console.error('Panoya kopyalanamadı:', err);
    }
  };

  // --- GİRİŞ VE ÇIKIŞ ---
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomPassword.trim()) return;

    try {
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'default'
      ) {
        Notification.requestPermission().catch(() => {});
      }

      await bridge.joinRoom(username, roomPassword);
      earlyStatusMapRef.current.clear();
      sentReadReceiptsRef.current.clear();
      setIsSelfMuted(false);
      setVerifiedAdminPassword(null);
      setIsLoggedIn(true);
      setActiveTabId(GROUP_TAB_ID);
      setTabs([{ id: GROUP_TAB_ID, title: 'Genel Kanal', isGroup: true, hasUnread: false }]);
      setHistories({
        [GROUP_TAB_ID]: [
          {
            id: crypto.randomUUID(),
            sender_id: 'SYSTEM',
            sender_name: 'Sistem',
            text: 'P2P şifreli ağ bağlantısı kuruldu. Ekran görüntüsü yapıştırmak için Ctrl+V, komutlar için /help kullanabilirsiniz.',
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            }),
            isMine: false,
            isSystem: true
          }
        ]
      });
    } catch (error) {
      console.error('Bağlantı hatası:', error);
      alert('Ağa bağlanılamadı. Arka plan servisini kontrol edin.');
    }
  };

  const handleDisconnect = () => {
    setIsLoggedIn(false);
    setIsPaletteOpen(false);
    setIsDragging(false);
    setPendingImage(null);
    setPreviewModal(null);
    setPeerMenu(null);
    setIsAdminModalOpen(false);
    setVerifiedAdminPassword(null);
    setAdminPasswordInput('');
    setIsSelfMuted(false);
    earlyStatusMapRef.current.clear();
    sentReadReceiptsRef.current.clear();
    setPeers([]);
    setHistories({ [GROUP_TAB_ID]: [] });
    setTabs([{ id: GROUP_TAB_ID, title: 'Genel Kanal', isGroup: true, hasUnread: false }]);
    setActiveTabId(GROUP_TAB_ID);
    setInputText('');
  };

  // --- SEKME YÖNETİMİ ---
  const handleSelectTab = (tabId: string) => {
    setActiveTabId(tabId);
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, hasUnread: false } : t))
    );
  };

  const handleOpenDmTab = (peer: ExtendedPeer) => {
    setTabs((prev) => {
      const exists = prev.some((t) => t.id === peer.id);
      if (exists) {
        return prev.map((t) =>
          t.id === peer.id ? { ...t, title: peer.username, hasUnread: false } : t
        );
      }
      return [
        ...prev,
        {
          id: peer.id,
          title: peer.username,
          isGroup: false,
          hasUnread: false
        }
      ];
    });

    setHistories((prev) => ({
      ...prev,
      [peer.id]: prev[peer.id] || [
        {
          id: crypto.randomUUID(),
          sender_id: 'SYSTEM',
          sender_name: 'Sistem',
          text: `${peer.username} (${peer.ip}) ile X25519 uçtan uca şifreli özel sohbet başlatıldı.`,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          isMine: false,
          isSystem: true
        }
      ]
    }));

    setActiveTabId(peer.id);
  };

  const handleCloseTab = (e: MouseEvent, tabId: string) => {
    e.stopPropagation();
    if (tabId === GROUP_TAB_ID) return;

    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId(GROUP_TAB_ID);
      setTabs((prev) =>
        prev.map((t) => (t.id === GROUP_TAB_ID ? { ...t, hasUnread: false } : t))
      );
    }
  };

  // --- SLASH KOMUTLARI ---
  const runSlashCommand = (command: string, targetTab = activeTabId) => {
    if (command === '/clear') {
      setHistories((prev) => ({
        ...prev,
        [targetTab]: [
          {
            id: crypto.randomUUID(),
            sender_id: 'SYSTEM',
            sender_name: 'Sistem',
            text: 'Sohbet geçmişi temizlendi.',
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            }),
            isMine: false,
            isSystem: true
          }
        ]
      }));
    } else if (command === '/help') {
      setHistories((prev) => ({
        ...prev,
        [targetTab]: [
          ...(prev[targetTab] || []),
          {
            id: crypto.randomUUID(),
            sender_id: 'SYSTEM',
            sender_name: 'Sistem',
            text: 'Kullanılabilir Komutlar ve Kısayollar:\n• /clear — Aktif sekmedeki mesaj geçmişini temizler.\n• /help — Bu yardım menüsünü gösterir.\n• Ctrl + V — Panodaki ekran görüntüsünü yapıştırıp gönderir.\n• Ctrl + K — Hızlı geçiş menüsünü açar.\n• Sürükle-Bırak — Pencereye bırakılan dosyaları aktif kanala otomatik gönderir.',
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            }),
            isMine: false,
            isSystem: true
          }
        ]
      }));
    }
  };

  // --- MESAJ VE PANO GÖRSELİ GÖNDERME ---
  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    const targetId = activeTabId === GROUP_TAB_ID ? null : activeTabId;

    // 1. Panodan yapıştırılmış bekleyen ekran görüntüsü varsa gönder
    if (pendingImage && !isSendingImage) {
      const imageToSend = pendingImage;
      setIsSendingImage(true);
      try {
        const savedPath = await bridge.sendClipboardImage(
          targetId,
          imageToSend.fileName,
          imageToSend.base64Data
        );

        const imgMsg: ChatMessage = {
          id: crypto.randomUUID(),
          sender_id: 'me',
          sender_name: username,
          text: imageToSend.fileName,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          isMine: true,
          status: 'sent',
          file: {
            fileName: imageToSend.fileName,
            filePath: savedPath || imageToSend.fileName,
            direction: 'sent'
          }
        };

        setHistories((prev) => ({
          ...prev,
          [activeTabId]: [...(prev[activeTabId] || []), imgMsg]
        }));
        setPendingImage(null);
      } catch (err) {
        console.error('Ekran görüntüsü gönderilemedi:', err);
        alert('Ekran görüntüsü gönderilemedi.');
      } finally {
        setIsSendingImage(false);
      }
    }

    // 2. Metin kutusunda yazı varsa gönder
    const rawText = inputText;
    const trimmed = rawText.trim();
    if (!trimmed) return;

    setInputText('');

    if (trimmed === '/clear' || trimmed === '/help') {
      runSlashCommand(trimmed);
      return;
    }

    try {
      const msgId = await bridge.sendMessage(targetId, rawText);
      const resolvedId = msgId || crypto.randomUUID();

      const bufferedStatus = earlyStatusMapRef.current.get(resolvedId);
      if (bufferedStatus) {
        earlyStatusMapRef.current.delete(resolvedId);
      }

      const newMsg: ChatMessage = {
        id: resolvedId,
        sender_id: 'me',
        sender_name: username,
        text: rawText,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }),
        isMine: true,
        status: bufferedStatus || 'sent'
      };

      setHistories((prev) => ({
        ...prev,
        [activeTabId]: [...(prev[activeTabId] || []), newMsg]
      }));
    } catch (err) {
      console.error('Mesaj gönderilemedi:', err);
    }
  };

  // --- ATAÇ İLE DOSYA GÖNDERME ---
  const handleAttachFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false
      });

      if (!selected || typeof selected !== 'string') return;
      await dispatchFileToTarget(selected);
    } catch (err) {
      console.error('Dosya seçme veya gönderme hatası:', err);
    }
  };

  // --- 4 AŞAMALI DURUM İKONU RENDER YARDIMCISI ---
  const renderDeliveryStatus = (status: MessageDeliveryStatus = 'sent') => {
    switch (status) {
      case 'queued':
        return (
          <span
            title="Kuyrukta bekliyor (Karşı taraf çevrimdışı)"
            className="inline-flex items-center text-amber-400/90"
          >
            <Clock className="w-3.5 h-3.5" />
          </span>
        );
      case 'sent':
        return (
          <span title="Gönderildi" className="inline-flex items-center text-zinc-500">
            <Check className="w-3.5 h-3.5" />
          </span>
        );
      case 'delivered':
        return (
          <span title="İletildi" className="inline-flex items-center text-zinc-400">
            <CheckCheck className="w-3.5 h-3.5" />
          </span>
        );
      case 'read':
        return (
          <span title="Görüldü" className="inline-flex items-center text-emerald-400">
            <CheckCheck className="w-3.5 h-3.5" />
          </span>
        );
    }
  };

  // --- EKRAN 1: MODERN GİRİŞ EKRANI ---
  if (!isLoggedIn) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-[#09090b] text-zinc-100 font-sans relative overflow-hidden">
        <div className="absolute w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />

        <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/90 rounded-2xl shadow-2xl relative z-10">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4 shadow-inner">
              <Shield className="w-6 h-6 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">LabChat</h1>
            <p className="text-sm text-zinc-400 mt-1">Uçtan uca şifreli yerel P2P iletişim ağı</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-zinc-500" /> Kullanıcı Adı
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-zinc-950/90 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 transition-all"
                placeholder="Örn: egehan"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5 text-zinc-500" /> Oda Parolası
              </label>
              <input
                type="password"
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
                className="w-full bg-zinc-950/90 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 transition-all tracking-widest"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-sm rounded-xl shadow-lg shadow-emerald-500/15 transition-all flex justify-center items-center gap-2 mt-2"
            >
              Ağa Bağlan
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const currentMessages = histories[activeTabId] || [];
  const activePeer = peers.find((p) => p.id === activeTabId);
  const onlinePeersCount = peers.filter((p) => p.online).length;

  // --- CTRL + K HIZLI GEÇİŞ ÖĞELERİ ---
  const quickItems: QuickActionItem[] = [
    ...tabs.map((t) => ({
      id: `tab-${t.id}`,
      label: t.isGroup ? '# BROADCAST_ALL' : `@${t.title}`,
      sublabel: t.isGroup ? 'Grup Kanalına Geç' : 'Açık Özel Sohbet Sekmesi',
      category: 'Sekmeler' as const,
      onSelect: () => handleSelectTab(t.id)
    })),
    ...peers.map((p) => ({
      id: `peer-${p.id}`,
      label: `@${p.username}`,
      sublabel: `${p.online ? 'Çevrimiçi' : 'Çevrimdışı (Kuyruk)'} • ${p.ip}`,
      category: 'Cihazlar' as const,
      onSelect: () => handleOpenDmTab(p)
    })),
    {
      id: 'cmd-admin',
      label: 'Admin Paneli — Moderasyon Yönetimi',
      sublabel: 'Ban ve Mute işlemlerini yönet',
      category: 'Komutlar',
      onSelect: () => handleOpenAdminModal()
    },
    {
      id: 'cmd-attach',
      label: 'Dosya Gönder...',
      sublabel: 'Aktif kanala dosya seçip gönder',
      category: 'Komutlar',
      onSelect: () => handleAttachFile()
    },
    {
      id: 'cmd-clear',
      label: '/clear — Sohbeti Temizle',
      sublabel: 'Aktif sekmedeki geçmişi sıfırla',
      category: 'Komutlar',
      onSelect: () => runSlashCommand('/clear')
    },
    {
      id: 'cmd-help',
      label: '/help — Yardım Menüsü',
      sublabel: 'Komut ve kısayol listesini göster',
      category: 'Komutlar',
      onSelect: () => runSlashCommand('/help')
    },
    {
      id: 'cmd-disconnect',
      label: 'Disconnect — Oturumu Kapat',
      sublabel: 'Ağ bağlantısını sonlandır ve giriş ekranına dön',
      category: 'Komutlar',
      onSelect: () => handleDisconnect()
    }
  ];

  const filteredQuickItems = quickItems.filter(
    (item) =>
      item.label.toLowerCase().includes(paletteQuery.toLowerCase()) ||
      item.sublabel.toLowerCase().includes(paletteQuery.toLowerCase())
  );

  const handlePaletteKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (filteredQuickItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredQuickItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredQuickItems.length) % filteredQuickItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredQuickItems[selectedIndex];
      if (target) {
        target.onSelect();
        setIsPaletteOpen(false);
      }
    }
  };

  // --- EKRAN 2: MODERN SEKMELİ SOHBET ARAYÜZÜ ---
  return (
    <div className="flex h-screen w-screen bg-[#09090b] text-zinc-100 font-sans select-none relative">
      {/* AĞDAKİ CİHAZLAR ÜÇ NOKTA / SAĞ TIK AÇILIR MENÜSÜ */}
      {peerMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ top: peerMenu.y, left: peerMenu.x }}
          className="fixed z-50 w-52 bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-2xl p-1.5 space-y-1"
        >
          <div className="px-2.5 py-1 text-[11px] font-medium text-zinc-500 border-b border-zinc-800/80 truncate">
            @{peerMenu.peer.username}
          </div>

          <button
            type="button"
            onClick={() => handleTogglePeerMute(peerMenu.peer)}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-zinc-200 hover:bg-zinc-800 transition-colors text-left"
          >
            {peerMenu.peer.is_muted ? (
              <>
                <Bell className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Sesi Aç</span>
              </>
            ) : (
              <>
                <BellOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Sustur</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => handleRemovePeer(peerMenu.peer)}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-rose-400 hover:bg-rose-500/15 transition-colors text-left"
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span>Sohbeti ve Kişiyi Sil</span>
          </button>
        </div>
      )}

      {/* ADMIN PANELİ MODALI */}
      {isAdminModalOpen && (
        <div
          onClick={() => setIsAdminModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden"
          >
            {/* Modal Üst Başlık */}
            <div className="px-5 py-4 border-b border-zinc-800 bg-zinc-950/70 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
                  <ShieldAlert className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">Admin Moderasyon Paneli</h3>
                  <p className="text-[11px] text-zinc-400">
                    {verifiedAdminPassword
                      ? 'Ağdaki aktif kullanıcıları susturabilir veya odadan yasaklayabilirsiniz'
                      : 'Devam etmek için yönetici parolasını doğrulayın'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsAdminModalOpen(false)}
                className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                title="Kapat (ESC)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal İçerik */}
            {!verifiedAdminPassword ? (
              <form onSubmit={handleVerifyAdmin} className="p-6 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-amber-400" /> Admin Şifresi
                  </label>
                  <input
                    type="password"
                    autoFocus
                    value={adminPasswordInput}
                    onChange={(e) => {
                      setAdminPasswordInput(e.target.value);
                      if (adminAuthError) setAdminAuthError(null);
                    }}
                    placeholder="Yönetici şifresini girin..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/60 focus:ring-2 focus:ring-amber-500/15 transition-all tracking-widest"
                    required
                  />
                </div>

                {adminAuthError && (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-300">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{adminAuthError}</span>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsAdminModalOpen(false)}
                    className="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 transition-colors"
                  >
                    Vazgeç
                  </button>
                  <button
                    type="submit"
                    disabled={isVerifyingAdmin}
                    className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 font-semibold text-xs flex items-center gap-2 transition-colors"
                  >
                    {isVerifyingAdmin && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Paneli Aç</span>
                  </button>
                </div>
              </form>
            ) : (
              <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
                <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
                  <span>Aktif Ağ Kullanıcıları ({peers.length})</span>
                  <button
                    type="button"
                    onClick={() => setVerifiedAdminPassword(null)}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 underline"
                  >
                    Oturumu Kilitle
                  </button>
                </div>

                {peers.length === 0 ? (
                  <div className="py-10 text-center text-xs text-zinc-500 bg-zinc-950/60 rounded-xl border border-zinc-800/80">
                    Şu anda ağda moderasyon uygulanabilecek başka kullanıcı yok
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {peers.map((peer) => {
                      const isMuted = Boolean(peer.is_muted);
                      const isBusy = moderatingPeerId === peer.id;

                      return (
                        <li
                          key={peer.id}
                          className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800/90 flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="relative shrink-0">
                              <div className="w-9 h-9 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-semibold uppercase text-zinc-200">
                                {peer.username.slice(0, 2)}
                              </div>
                              <span
                                className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-zinc-950 ${
                                  peer.online ? 'bg-emerald-400' : 'bg-zinc-500'
                                }`}
                              />
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium text-zinc-100 truncate">
                                  {peer.username}
                                </span>
                                {isMuted && (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300">
                                    <VolumeX className="w-2.5 h-2.5" />
                                    Susturuldu
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] font-mono text-zinc-500 truncate">
                                {peer.ip} • {peer.online ? 'Çevrimiçi' : 'Çevrimdışı'}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleAdminModerate(peer, isMuted ? 'unmute' : 'mute')
                              }
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                                isMuted
                                  ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/30 text-emerald-300'
                                  : 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30 text-amber-300'
                              }`}
                            >
                              {isMuted ? (
                                <>
                                  <Volume2 className="w-3.5 h-3.5" />
                                  <span>Susturmayı Kaldır</span>
                                </>
                              ) : (
                                <>
                                  <VolumeX className="w-3.5 h-3.5" />
                                  <span>Sustur</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleAdminModerate(peer, 'ban')}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 transition-colors disabled:opacity-50"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>Banla</span>
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* DOSYA OKUYUCU / ÖNİZLEYİCİ MODALI (.png, .jpg, .txt) */}
      {previewModal && (
        <div
          onClick={() => setPreviewModal(null)}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl max-h-[88vh] bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-zinc-800 bg-zinc-950/70 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center shrink-0">
                  {previewModal.data?.file_type === 'image' ? (
                    <ImageIcon className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <FileText className="w-4 h-4 text-emerald-400" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-100 truncate">
                    {previewModal.fileName}
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500 truncate">
                    {previewModal.filePath}
                    {previewModal.data ? ` • ${formatBytes(previewModal.data.file_size)}` : ''}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {previewModal.data?.file_type === 'image' && (
                  <button
                    type="button"
                    onClick={() => setImageZoomed((prev) => !prev)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 transition-colors"
                  >
                    {imageZoomed ? (
                      <>
                        <ZoomOut className="w-3.5 h-3.5" />
                        <span>Sığdır</span>
                      </>
                    ) : (
                      <>
                        <ZoomIn className="w-3.5 h-3.5" />
                        <span>%100 Boyut</span>
                      </>
                    )}
                  </button>
                )}

                {previewModal.data?.file_type === 'text' && (
                  <button
                    type="button"
                    onClick={() => handleCopy('modal-text', previewModal.data!.content)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 transition-colors"
                  >
                    {copiedId === 'modal-text' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Kopyalandı</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>İçeriği Kopyala</span>
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setPreviewModal(null)}
                  className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                  title="Kapat (ESC)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-6 bg-[#09090b] flex items-center justify-center select-text">
              {previewModal.loading && (
                <div className="flex flex-col items-center gap-3 py-16 text-zinc-400">
                  <Loader2 className="w-7 h-7 text-emerald-400 animate-spin" />
                  <span className="text-xs">Dosya okunuyor...</span>
                </div>
              )}

              {previewModal.error && (
                <div className="flex flex-col items-center text-center gap-2 py-12 max-w-md">
                  <AlertCircle className="w-8 h-8 text-rose-400" />
                  <p className="text-sm font-medium text-zinc-200">Önizleme Açılamadı</p>
                  <p className="text-xs text-zinc-400">{previewModal.error}</p>
                </div>
              )}

              {previewModal.data?.file_type === 'image' && (
                <div className="w-full h-full flex items-center justify-center overflow-auto">
                  <img
                    src={previewModal.data.content}
                    alt={previewModal.fileName}
                    onClick={() => setImageZoomed((prev) => !prev)}
                    className={`rounded-xl border border-zinc-800 shadow-lg cursor-zoom-in transition-all ${
                      imageZoomed ? 'max-w-none' : 'max-h-[70vh] max-w-full object-contain'
                    }`}
                  />
                </div>
              )}

              {previewModal.data?.file_type === 'text' && (
                <pre className="w-full h-full min-h-[300px] p-4 rounded-xl bg-zinc-950 border border-zinc-800/90 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words leading-relaxed overflow-auto self-start">
                  {previewModal.data.content || '(Boş dosya)'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SÜRÜKLE-BIRAK OVERLAY */}
      {isDragging && (
        <div className="fixed inset-0 z-50 bg-zinc-950/80 backdrop-blur-md flex items-center justify-center p-8 pointer-events-none">
          <div className="w-full max-w-lg p-10 rounded-3xl border-2 border-dashed border-emerald-500/70 bg-zinc-900/90 flex flex-col items-center text-center shadow-2xl">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mb-4">
              <UploadCloud className="w-7 h-7 text-emerald-400 animate-bounce" />
            </div>
            <h2 className="text-lg font-semibold text-white">Dosyayı Göndermek İçin Bırakın</h2>
            <p className="text-sm text-zinc-400 mt-1">
              Hedef Kanal:{' '}
              <span className="text-emerald-400 font-medium">
                {activeTab.isGroup ? '# BROADCAST_ALL' : `@${activeTab.title}`}
              </span>
            </p>
          </div>
        </div>
      )}

      {/* CTRL + K HIZLI GEÇİŞ KOMUT PALETİ */}
      {isPaletteOpen && (
        <div
          onClick={() => setIsPaletteOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[14vh] px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-zinc-800">
              <Search className="w-4 h-4 text-zinc-400 shrink-0" />
              <input
                ref={paletteInputRef}
                type="text"
                value={paletteQuery}
                onChange={(e) => {
                  setPaletteQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Cihaz, sekme veya komut ara..."
                className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
              />
              <span className="text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                ESC
              </span>
            </div>

            <div className="max-h-72 overflow-y-auto p-2 space-y-1">
              {filteredQuickItems.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">
                  Eşleşen sonuç bulunamadı
                </div>
              ) : (
                filteredQuickItems.map((item, idx) => {
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => {
                        item.onSelect();
                        setIsPaletteOpen(false);
                      }}
                      className={`w-full text-left px-3.5 py-2.5 rounded-xl flex items-center justify-between transition-colors ${
                        isSelected
                          ? 'bg-emerald-500/15 text-white border border-emerald-500/30'
                          : 'text-zinc-300 hover:bg-zinc-800/70 border border-transparent'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{item.label}</div>
                        <div className="text-[11px] text-zinc-500 truncate">{item.sublabel}</div>
                      </div>
                      <span className="text-[10px] font-medium text-zinc-400 bg-zinc-800/90 px-2 py-0.5 rounded-md shrink-0 ml-2">
                        {item.category}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* SOL KENAR ÇUBUĞU (SIDEBAR) */}
      <aside className="w-72 border-r border-zinc-800/80 bg-[#0c0c0f] flex flex-col">
        <div className="h-14 px-5 border-b border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Shield className="w-4 h-4 text-emerald-400" />
            </div>
            <span className="font-semibold tracking-tight text-zinc-100">LabChat</span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Aktif
          </span>
        </div>

        {/* Hızlı Arama Butonu */}
        <div className="px-3.5 pt-3.5">
          <button
            type="button"
            onClick={() => {
              setIsPaletteOpen(true);
              setPaletteQuery('');
              setSelectedIndex(0);
            }}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-900/90 hover:bg-zinc-800/90 border border-zinc-800 text-xs text-zinc-400 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-zinc-500" />
              Hızlı Geçiş...
            </span>
            <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-zinc-500 bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800">
              <Command className="w-2.5 h-2.5" />K
            </span>
          </button>
        </div>

        {/* Çevrimiçi / Çevrimdışı Düğümler Listesi */}
        <div className="p-3.5 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-2 mb-3 text-xs font-medium text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-zinc-500" />
              Ağdaki Cihazlar
            </span>
            <span
              title={`${onlinePeersCount} çevrimiçi / ${peers.length} toplam kayıtlı cihaz`}
              className="text-[11px] bg-zinc-800/80 text-zinc-300 px-2 py-0.5 rounded-md font-mono"
            >
              {onlinePeersCount}/{peers.length}
            </span>
          </div>

          <ul className="space-y-1.5">
            {peers.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-zinc-500 bg-zinc-900/40 rounded-xl border border-zinc-800/50">
                Ağda başka cihaz bulunamadı
              </li>
            )}
            {peers.map((peer) => {
              const isSelectedDm = activeTabId === peer.id;
              const isOnline = Boolean(peer.online);
              const isMuted = Boolean(peer.is_muted);

              return (
                <li
                  key={peer.id}
                  onClick={() => handleOpenDmTab(peer)}
                  onContextMenu={(e) => handleOpenPeerMenu(e, peer)}
                  className={`p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between group ${
                    isSelectedDm
                      ? 'bg-zinc-800/90 border-zinc-700 text-white shadow-sm'
                      : 'bg-transparent border-transparent hover:bg-zinc-900/90 hover:border-zinc-800/80 text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative shrink-0">
                      <div
                        className={`w-8 h-8 rounded-lg border flex items-center justify-center text-xs font-semibold uppercase transition-colors ${
                          isOnline
                            ? 'bg-zinc-800 border-zinc-700/80 text-zinc-200'
                            : 'bg-zinc-900/80 border-zinc-800 text-zinc-500'
                        }`}
                      >
                        {peer.username.slice(0, 2)}
                      </div>
                      <span
                        title={isOnline ? 'Çevrimiçi' : 'Çevrimdışı (Mesajlar kuyruğa alınır)'}
                        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[#0c0c0f] ${
                          isOnline ? 'bg-emerald-400' : 'bg-zinc-500'
                        }`}
                      />
                    </div>
                    <div className="truncate">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-sm font-medium truncate ${
                            isOnline ? 'text-zinc-200' : 'text-zinc-400'
                          }`}
                        >
                          {peer.username}
                        </span>
                        {isMuted && (
                          <span title="Susturulmuş kullanıcı">
                            <BellOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 font-mono truncate">
                        {isOnline ? peer.ip : `${peer.ip} • Çevrimdışı`}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => handleOpenPeerMenu(e, peer)}
                    title="Kişi Seçenekleri"
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Alt Bölüm: Admin Panel Butonu ve Şifreleme Bilgisi */}
        <div className="p-3.5 border-t border-zinc-800/80 bg-zinc-950/40 space-y-2.5">
          <button
            type="button"
            onClick={handleOpenAdminModal}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/25 text-xs font-medium text-amber-300 transition-colors"
          >
            <span className="flex items-center gap-2">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>Admin Panel</span>
            </span>
            <Lock className="w-3 h-3 text-amber-400/80" />
          </button>

          <div className="flex items-center justify-between text-xs text-zinc-500 px-1">
            <span className="flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-emerald-500/80" />
              E2E Şifreleme Aktif
            </span>
            <span className="font-mono text-[11px] text-zinc-600">P2P</span>
          </div>
        </div>
      </aside>

      {/* SAĞ ANA ALAN */}
      <main className="flex-1 flex flex-col bg-[#09090b] min-w-0">
        {/* Üst Sekme Çubuğu (Tab Bar) */}
        <div className="h-11 bg-[#0c0c0f] border-b border-zinc-800/80 px-3 flex items-center gap-1.5 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => handleSelectTab(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all shrink-0 ${
                  isActive
                    ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/70'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/80 border border-transparent'
                }`}
              >
                {tab.isGroup ? (
                  <Hash className={`w-3.5 h-3.5 ${isActive ? 'text-emerald-400' : 'text-zinc-500'}`} />
                ) : (
                  <MessageSquare className={`w-3.5 h-3.5 ${isActive ? 'text-emerald-400' : 'text-zinc-500'}`} />
                )}
                <span>{tab.isGroup ? 'BROADCAST_ALL' : tab.title}</span>

                {tab.hasUnread && !isActive && (
                  <span
                    title="Okunmamış mesaj"
                    className="w-2 h-2 rounded-full bg-emerald-400"
                  />
                )}

                {!tab.isGroup && (
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(e, tab.id)}
                    className="ml-1 p-0.5 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700 rounded transition-colors"
                    title="Sekmeyi Kapat"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Üst Durum, X25519 E2EE Rozeti ve Oturum Barı */}
        <header className="h-14 border-b border-zinc-800/80 px-6 bg-zinc-950/60 backdrop-blur-md flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-zinc-100 truncate">
                {activeTab.isGroup ? '# BROADCAST_ALL' : `@${activeTab.title}`}
              </span>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400 font-mono">
                {activeTab.isGroup ? 'Grup Ağı' : activePeer ? activePeer.ip : 'Özel Mesaj'}
              </span>

              {/* DM Sekmelerinde X25519 E2EE Aktif Kilit Rozeti */}
              {!activeTab.isGroup && (
                <span
                  title="X25519 Elliptic-Curve Diffie-Hellman Uçtan Uca Anahtar Değişimi Aktif"
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 shadow-sm"
                >
                  <Lock className="w-3 h-3 text-emerald-400" />
                  <span>X25519 E2EE Aktif</span>
                </span>
              )}

              {/* Çevrimdışı Peer Kuyruk Uyarısı */}
              {!activeTab.isGroup && activePeer && !activePeer.online && (
                <span
                  title="Kullanıcı şu an çevrimdışı; gönderilen mesaj ve dosyalar çevrimiçi olduğu an otomatik iletilir."
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400"
                >
                  <Clock className="w-3 h-3" />
                  <span>Çevrimdışı • Kuyruk Modu</span>
                </span>
              )}

              {/* Kullanıcının Kendisi Admin Tarafından Susturulduysa Bilgi Rozeti */}
              {isSelfMuted && (
                <span
                  title="Admin tarafından susturuldunuz; gönderdiğiniz mesajlar ağa iletilmeyebilir."
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-300"
                >
                  <VolumeX className="w-3 h-3 text-rose-400" />
                  <span>Admin Tarafından Susturuldunuz</span>
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div
              title="Aktif oturum süresi"
              className="flex items-center gap-1.5 text-xs font-mono text-zinc-400 bg-zinc-900/90 border border-zinc-800 px-2.5 py-1.5 rounded-lg"
            >
              <Clock className="w-3.5 h-3.5 text-emerald-400" />
              <span>{formatUptime(uptimeSeconds)}</span>
            </div>

            <div className="text-xs font-medium text-zinc-300 bg-zinc-900/90 border border-zinc-800 px-3 py-1.5 rounded-lg">
              {username}
            </div>

            <button
              type="button"
              onClick={handleDisconnect}
              title="Oturumu Kapat ve Çık"
              className="flex items-center gap-1.5 text-xs font-medium text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/20 px-3 py-1.5 rounded-lg transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Disconnect</span>
            </button>
          </div>
        </header>

        {/* Mesaj ve Dosya Akışı */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 select-text">
          {currentMessages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500">
              <p className="text-sm">Henüz mesaj yok</p>
              <p className="text-xs text-zinc-600 mt-1">
                Mesaj yazabilir, ekran görüntüsü yapıştırabilir (Ctrl+V) veya dosya sürükleyebilirsiniz
              </p>
            </div>
          )}

          {currentMessages.map((msg) => {
            if (msg.isSystem) {
              return (
                <div key={msg.id} className="flex justify-center my-2">
                  <div className="px-3.5 py-1.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 text-xs text-zinc-400 max-w-xl whitespace-pre-wrap">
                    {msg.text}
                  </div>
                </div>
              );
            }

            const hasCode = !msg.file && isCodeMessage(msg.text);
            const canPreview = msg.file ? isPreviewableFile(msg.file.fileName) : false;

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.isMine ? 'items-end' : 'items-start'}`}
              >
                {/* Gönderen, Saat ve 4 Aşamalı Teslim/Okundu İkonu */}
                <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] text-zinc-500">
                  {!msg.isMine && (
                    <span className="font-medium text-zinc-300 mr-0.5">{msg.sender_name}</span>
                  )}
                  <span className="font-mono">{msg.timestamp}</span>
                  {msg.isMine && renderDeliveryStatus(msg.status)}
                </div>

                {msg.file ? (
                  <div
                    className={`w-full max-w-md p-3.5 rounded-2xl border transition-all ${
                      msg.isMine
                        ? 'bg-emerald-500/10 border-emerald-500/25'
                        : 'bg-zinc-900/90 border-zinc-800'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        onClick={() => canPreview && handleOpenFilePreview(msg.file!)}
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          canPreview ? 'cursor-pointer hover:opacity-80' : ''
                        } ${
                          msg.isMine
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        <FileText className="w-5 h-5" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[11px] font-medium mb-0.5">
                          {msg.file.direction === 'sent' ? (
                            <span className="text-emerald-400 flex items-center gap-0.5">
                              <ArrowUpRight className="w-3 h-3" /> Dosya Gönderildi
                            </span>
                          ) : (
                            <span className="text-sky-400 flex items-center gap-0.5">
                              <ArrowDownLeft className="w-3 h-3" /> Dosya Alındı
                            </span>
                          )}
                        </div>
                        <div
                          onClick={() => canPreview && handleOpenFilePreview(msg.file!)}
                          className={`text-sm font-medium text-zinc-100 truncate ${
                            canPreview ? 'cursor-pointer hover:text-emerald-400 transition-colors' : ''
                          }`}
                          title={msg.file.fileName}
                        >
                          {msg.file.fileName}
                        </div>
                        <div className="text-[11px] font-mono text-zinc-500 truncate mt-1" title={msg.file.filePath}>
                          {msg.file.filePath}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {canPreview && (
                          <button
                            type="button"
                            onClick={() => handleOpenFilePreview(msg.file!)}
                            title="Dosyayı Oku / Önizle"
                            className="flex items-center gap-1 px-2.5 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/25 text-emerald-300 text-xs font-medium transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Önizle</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleCopy(msg.id, msg.file!.filePath)}
                          title="Dosya yolunu kopyala"
                          className="p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
                        >
                          {copiedId === msg.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`group relative max-w-[75%] rounded-2xl border transition-all ${
                      hasCode
                        ? 'bg-zinc-950 border-zinc-800 p-0 overflow-hidden'
                        : msg.isMine
                          ? 'bg-emerald-500/15 border-emerald-500/25 text-zinc-100 px-4 py-2.5'
                          : 'bg-zinc-900 border-zinc-800/90 text-zinc-200 px-4 py-2.5'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleCopy(msg.id, hasCode ? cleanCodeContent(msg.text) : msg.text)}
                      title="Metni kopyala"
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 opacity-0 group-hover:opacity-100 transition-opacity border border-zinc-700/60"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {hasCode ? (
                      <div>
                        <div className="px-3.5 py-1.5 bg-zinc-900/90 border-b border-zinc-800 flex items-center gap-1.5 text-[11px] font-mono text-zinc-400">
                          <Terminal className="w-3 h-3 text-emerald-400" />
                          <span>snippet</span>
                        </div>
                        <pre className="p-3.5 pr-10 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words leading-relaxed overflow-x-auto">
                          {cleanCodeContent(msg.text)}
                        </pre>
                      </div>
                    ) : (
                      <p className="text-sm leading-relaxed break-words pr-6">{msg.text}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Alt Mesaj Gönderme Çubuğu + Ctrl+V Pano Görsel Önizleme */}
        <div className="p-4 bg-[#0c0c0f] border-t border-zinc-800/80 space-y-3">
          {pendingImage && (
            <div className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-zinc-900 border border-emerald-500/30">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={pendingImage.base64Data}
                  alt="Pano önizleme"
                  className="w-12 h-12 rounded-lg object-cover border border-zinc-700 shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-emerald-400 flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5" />
                    <span>Panodan Ekran Görüntüsü Hazır</span>
                  </div>
                  <div className="text-xs text-zinc-300 truncate mt-0.5">
                    {pendingImage.fileName} • {pendingImage.sizeKB} KB
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setPendingImage(null)}
                title="İptal Et (ESC)"
                className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <form onSubmit={handleSendMessage} className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleAttachFile}
              title="Dosya Gönder"
              className="p-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors shrink-0"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <input
              ref={messageInputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onPaste={(e) => {
                const handled = processClipboardItems(e.clipboardData?.items);
                if (handled) e.preventDefault();
              }}
              placeholder={
                isSelfMuted
                  ? 'Admin tarafından susturuldunuz...'
                  : pendingImage
                    ? 'Ekran görüntüsünü göndermek için Enter’a basın...'
                    : activeTab.isGroup
                      ? 'Gruba mesaj yazın, ekran görüntüsü yapıştırın (Ctrl+V) veya /help deneyin...'
                      : activePeer && !activePeer.online
                        ? `@${activeTab.title} çevrimdışı — mesajınız kuyruğa alınacak...`
                        : `@${activeTab.title} kullanıcısına X25519 şifreli mesaj yazın...`
              }
              className="flex-1 bg-zinc-900/90 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/10 transition-all"
            />

            <button
              type="submit"
              disabled={isSendingImage}
              className="px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 font-semibold text-sm flex items-center gap-2 shadow-lg shadow-emerald-500/10 transition-all shrink-0"
            >
              {isSendingImage ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              <span>Gönder</span>
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}