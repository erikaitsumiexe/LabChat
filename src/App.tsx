import { useState, useEffect, useRef, FormEvent } from 'react';
import { Terminal, Users, Send, Paperclip, Lock, ShieldAlert, Wifi, Key, X, Hash, MessageSquare } from 'lucide-react';
import { UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { bridge, Peer } from './services/bridge';

interface ChatTab {
  id: string;
  title: string;
  isGroup: boolean;
  hasUnread: boolean;
}

interface ChatMessage {
  sender_id: string;
  sender_name: string;
  text: string;
  timestamp: string;
  isMine: boolean;
  isSystem?: boolean;
}

interface IncomingMessagePayload {
  sender_id: string;
  sender_name?: string;
  text: string;
  timestamp: string;
  is_private?: boolean;
}

interface IncomingFilePayload {
  sender_id: string;
  sender_name?: string;
  file_path: string;
  file_name: string;
  timestamp?: string;
  is_private?: boolean;
}

const GROUP_TAB_ID = 'group';

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [roomPassword, setRoomPassword] = useState('');

  const [peers, setPeers] = useState<Peer[]>([]);
  const [tabs, setTabs] = useState<ChatTab[]>([
    { id: GROUP_TAB_ID, title: '# BROADCAST_ALL', isGroup: true, hasUnread: false }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(GROUP_TAB_ID);
  const [histories, setHistories] = useState<Record<string, ChatMessage[]>>({
    [GROUP_TAB_ID]: []
  });
  const [inputText, setInputText] = useState('');

  const activeTabRef = useRef<string>(GROUP_TAB_ID);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeTabRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [histories, activeTabId]);

  useEffect(() => {
    if (!isLoggedIn) return;

    let unlistenPeers: UnlistenFn | undefined;
    let unlistenMessages: UnlistenFn | undefined;
    let unlistenFiles: UnlistenFn | undefined;

    const handleIncomingItem = (
      targetTabId: string,
      tabTitle: string,
      isPrivate: boolean,
      newMsg: ChatMessage
    ) => {
      setTabs((prevTabs) => {
        const exists = prevTabs.some((t) => t.id === targetTabId);
        const isCurrentlyActive = activeTabRef.current === targetTabId;

        if (!exists && isPrivate) {
          return [
            ...prevTabs,
            {
              id: targetTabId,
              title: `@${tabTitle}`,
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
    };

    const setupListeners = async () => {
      try {
        unlistenPeers = await bridge.onPeersUpdated((updatedPeers) => {
          setPeers(updatedPeers);
          setTabs((prevTabs) =>
            prevTabs.map((tab) => {
              if (tab.isGroup) return tab;
              const matchedPeer = updatedPeers.find((p) => p.id === tab.id);
              return matchedPeer ? { ...tab, title: `@${matchedPeer.username}` } : tab;
            })
          );
        });

        unlistenMessages = await bridge.onMessageReceived((rawMsg) => {
          const msg = rawMsg as unknown as IncomingMessagePayload;
          const isPrivate = Boolean(msg.is_private);
          const targetTabId = isPrivate ? msg.sender_id : GROUP_TAB_ID;
          const displayName = msg.sender_name || msg.sender_id;

          handleIncomingItem(targetTabId, displayName, isPrivate, {
            sender_id: msg.sender_id,
            sender_name: displayName,
            text: msg.text,
            timestamp: msg.timestamp || new Date().toLocaleTimeString(),
            isMine: false
          });
        });

        unlistenFiles = await bridge.onFileReceived((rawFile) => {
          const file = rawFile as unknown as IncomingFilePayload;
          const isPrivate = Boolean(file.is_private);
          const targetTabId = isPrivate ? file.sender_id : GROUP_TAB_ID;
          const displayName = file.sender_name || file.sender_id;

          handleIncomingItem(targetTabId, displayName, isPrivate, {
            sender_id: file.sender_id,
            sender_name: displayName,
            text: `[DOSYA ALINDI]: ${file.file_name} (Kaydedildi: ${file.file_path})`,
            timestamp: file.timestamp || new Date().toLocaleTimeString(),
            isMine: false
          });
        });
      } catch (error) {
        console.error('Listener başlatılırken hata oluştu:', error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenPeers) unlistenPeers();
      if (unlistenMessages) unlistenMessages();
      if (unlistenFiles) unlistenFiles();
    };
  }, [isLoggedIn]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomPassword.trim()) return;

    try {
      await bridge.joinRoom(username, roomPassword);
      setIsLoggedIn(true);
      setHistories({
        [GROUP_TAB_ID]: [
          {
            sender_id: 'SYSTEM',
            sender_name: 'SYSTEM',
            text: 'Bağlantı kuruldu. Ağ dinleniyor...',
            timestamp: new Date().toLocaleTimeString(),
            isMine: false,
            isSystem: true
          }
        ]
      });
    } catch (error) {
      console.error('Bağlantı hatası:', error);
      alert('Ağa bağlanılamadı. Arka planı kontrol edin.');
    }
  };

  const handleSelectTab = (tabId: string) => {
    setActiveTabId(tabId);
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, hasUnread: false } : t))
    );
  };

  const handleOpenDmTab = (peer: Peer) => {
    setTabs((prev) => {
      const exists = prev.some((t) => t.id === peer.id);
      if (exists) {
        return prev.map((t) =>
          t.id === peer.id ? { ...t, title: `@${peer.username}`, hasUnread: false } : t
        );
      }
      return [
        ...prev,
        {
          id: peer.id,
          title: `@${peer.username}`,
          isGroup: false,
          hasUnread: false
        }
      ];
    });

    setHistories((prev) => ({
      ...prev,
      [peer.id]: prev[peer.id] || [
        {
          sender_id: 'SYSTEM',
          sender_name: 'SYSTEM',
          text: `@${peer.username} (${peer.ip}) ile uçtan uca şifreli özel kanal açıldı.`,
          timestamp: new Date().toLocaleTimeString(),
          isMine: false,
          isSystem: true
        }
      ]
    }));

    setActiveTabId(peer.id);
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
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

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const targetId = activeTabId === GROUP_TAB_ID ? null : activeTabId;
    const textToSend = inputText;
    setInputText('');

    const newMsg: ChatMessage = {
      sender_id: 'me',
      sender_name: username,
      text: textToSend,
      timestamp: new Date().toLocaleTimeString(),
      isMine: true
    };

    setHistories((prev) => ({
      ...prev,
      [activeTabId]: [...(prev[activeTabId] || []), newMsg]
    }));

    try {
      await bridge.sendMessage(targetId, textToSend);
    } catch (err) {
      console.error('Mesaj gönderilemedi:', err);
    }
  };

  const handleAttachFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false
      });

      if (!selected || typeof selected !== 'string') return;

      const targetId = activeTabId === GROUP_TAB_ID ? null : activeTabId;
      const fileName = selected.split(/[/\\]/).pop() || selected;

      await bridge.sendFile(targetId, selected);

      const fileMsg: ChatMessage = {
        sender_id: 'me',
        sender_name: username,
        text: `[DOSYA GÖNDERİLDİ]: ${fileName}`,
        timestamp: new Date().toLocaleTimeString(),
        isMine: true
      };

      setHistories((prev) => ({
        ...prev,
        [activeTabId]: [...(prev[activeTabId] || []), fileMsg]
      }));
    } catch (err) {
      console.error('Dosya seçme veya gönderme hatası:', err);
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-[#050505] text-[#00ff41] font-mono">
        <div className="w-full max-w-md p-8 bg-[#0a0a0a] border border-[#00ff41]/40 rounded shadow-[0_0_30px_rgba(0,255,65,0.15)] relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-[#00ff41] opacity-50 shadow-[0_0_10px_#00ff41] animate-[scan_2s_ease-in-out_infinite]"></div>

          <div className="flex flex-col items-center mb-8">
            <Terminal className="w-12 h-12 mb-4 animate-pulse drop-shadow-[0_0_10px_rgba(0,255,65,0.8)]" />
            <h1 className="text-3xl font-bold tracking-widest drop-shadow-[0_0_5px_rgba(0,255,65,0.5)] uppercase">LabChat_v1</h1>
            <p className="text-xs text-[#00ff41]/60 mt-2">SECURE P2P PROTOCOL</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs flex items-center gap-2 text-[#00ff41]/80"><Wifi className="w-3 h-3" /> IDENTIFIER</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-black border border-[#00ff41]/30 p-3 text-[#00ff41] focus:outline-none focus:border-[#00ff41] focus:shadow-[0_0_10px_rgba(0,255,65,0.2)] transition-all"
                placeholder="Örn: zero_day"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs flex items-center gap-2 text-[#00ff41]/80"><Key className="w-3 h-3" /> NETWORK KEY</label>
              <input
                type="password"
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
                className="w-full bg-black border border-[#00ff41]/30 p-3 text-[#00ff41] focus:outline-none focus:border-[#00ff41] focus:shadow-[0_0_10px_rgba(0,255,65,0.2)] transition-all tracking-widest"
                placeholder="••••••••"
                required
              />
            </div>
            <button
              type="submit"
              className="w-full py-4 bg-[#00ff41]/10 border border-[#00ff41] text-[#00ff41] font-bold tracking-widest hover:bg-[#00ff41] hover:text-black hover:shadow-[0_0_20px_rgba(0,255,65,0.6)] transition-all flex justify-center items-center gap-3"
            >
              <ShieldAlert className="w-5 h-5" /> AĞA KATIL
            </button>
          </form>
        </div>
        <style>{`@keyframes scan { 0% { top: -10px; } 50% { top: 100%; } 100% { top: -10px; } }`}</style>
      </div>
    );
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const currentMessages = histories[activeTabId] || [];

  return (
    <div className="flex h-screen w-screen bg-[#050505] text-[#00ff41] font-mono">
      {/* SOL PANEL - NODE_LIST */}
      <div className="w-72 border-r border-[#00ff41]/30 bg-[#0a0a0a] flex flex-col z-10">
        <div className="p-5 border-b border-[#00ff41]/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Terminal className="text-[#00ff41] w-5 h-5" />
            <h1 className="text-lg font-bold tracking-widest uppercase">LabChat</h1>
          </div>
          <div className="w-2 h-2 rounded-full bg-[#00ff41] animate-ping"></div>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 mb-4 text-[#00ff41]/70 text-xs border-b border-[#00ff41]/20 pb-2 uppercase tracking-wider">
            <Users className="w-4 h-4" />
            <span>NODE_LIST ({peers.length})</span>
          </div>

          <ul className="space-y-3">
            {peers.length === 0 && (
              <li className="text-xs text-[#00ff41]/40 italic">Ağda kimse yok...</li>
            )}
            {peers.map((peer) => {
              const isSelectedDm = activeTabId === peer.id;
              return (
                <li
                  key={peer.id}
                  onClick={() => handleOpenDmTab(peer)}
                  title="Özel mesaj (DM) başlat"
                  className={`p-3 border transition-all cursor-pointer group ${
                    isSelectedDm
                      ? 'border-[#00ff41] bg-[#00ff41]/15 shadow-[0_0_12px_rgba(0,255,65,0.2)]'
                      : 'border-[#00ff41]/20 bg-black hover:bg-[#00ff41]/10 hover:border-[#00ff41]/50'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-[#00ff41] group-hover:drop-shadow-[0_0_5px_rgba(0,255,65,0.8)]">
                      @{peer.username}
                    </span>
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00ff41] shadow-[0_0_5px_#00ff41]"></span>
                  </div>
                  <div className="text-[10px] text-[#00ff41]/50 mt-1 flex items-center justify-between">
                    <span>{peer.ip}</span>
                    <span className="opacity-0 group-hover:opacity-100 text-[#00ff41] transition-opacity">
                      [DM]
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="p-4 text-[10px] border-t border-[#00ff41]/30 text-[#00ff41]/50 flex items-center justify-between bg-black">
          <span className="tracking-widest">ENCRYPTION: ENABLED</span>
          <Lock className="w-3 h-3 text-[#00ff41]" />
        </div>
      </div>

      {/* SAĞ PANEL - SEKMELER VE MESAJLAŞMA */}
      <div className="flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#0a0a0a] to-[#050505]">
        <div className="flex items-center bg-[#070707] border-b border-[#00ff41]/30 px-2 pt-2 gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => handleSelectTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 text-xs cursor-pointer border-t border-x transition-all select-none shrink-0 ${
                  isActive
                    ? 'bg-[#0a0a0a] border-[#00ff41]/60 text-[#00ff41] font-bold shadow-[0_-2px_10px_rgba(0,255,65,0.1)]'
                    : 'bg-black/60 border-[#00ff41]/15 text-[#00ff41]/50 hover:text-[#00ff41]/80 hover:border-[#00ff41]/30'
                }`}
              >
                {tab.isGroup ? (
                  <Hash className="w-3.5 h-3.5 text-[#00ff41]" />
                ) : (
                  <MessageSquare className="w-3.5 h-3.5 text-[#00ff41]" />
                )}
                <span>{tab.isGroup ? 'BROADCAST_ALL' : tab.title}</span>

                {tab.hasUnread && !isActive && (
                  <span
                    title="Yeni mesaj/dosya"
                    className="w-2 h-2 rounded-full bg-[#00ff41] animate-pulse shadow-[0_0_8px_#00ff41]"
                  />
                )}

                {!tab.isGroup && (
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(e, tab.id)}
                    className="ml-1 p-0.5 text-[#00ff41]/50 hover:text-black hover:bg-[#00ff41] rounded-sm transition-colors"
                    title="Sekmeyi Kapat"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="h-14 border-b border-[#00ff41]/30 flex items-center px-6 bg-[#0a0a0a]/80 justify-between">
          <div>
            <div className="font-bold text-sm tracking-wider drop-shadow-[0_0_5px_rgba(0,255,65,0.3)]">
              {'>'} TARGET: {activeTab.isGroup ? 'BROADCAST_ALL (GROUP)' : `${activeTab.title} (DIRECT_MESSAGE)`}
            </div>
            <div className="text-[10px] text-[#00ff41]/40 uppercase tracking-widest mt-0.5">
              {activeTab.isGroup ? 'P2P MESH BROADCAST CHANNEL' : 'PRIVATE E2E ENCRYPTED SESSION'}
            </div>
          </div>
          <div className="text-xs text-[#00ff41]/60 bg-[#00ff41]/10 px-3 py-1 border border-[#00ff41]/30">
            USER: {username}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {currentMessages.length === 0 && (
            <div className="text-xs text-[#00ff41]/30 italic text-center mt-10">
              Bu kanalda henüz mesaj yok. İletişim başlatmak için aşağıdan veri gönderin.
            </div>
          )}
          {currentMessages.map((msg, idx) => (
            <div key={idx} className={`flex flex-col ${msg.isMine ? 'items-end' : 'items-start'}`}>
              <div className="text-[10px] text-[#00ff41]/50 mb-1 flex gap-2 tracking-widest">
                {!msg.isMine && (
                  <span className="font-bold text-[#00ff41]/80">
                    {msg.isSystem ? '[SYSTEM]' : `@${msg.sender_name}`}
                  </span>
                )}
                <span>[{msg.timestamp}]</span>
              </div>
              <div
                className={`px-4 py-2.5 max-w-[75%] border break-all text-sm leading-relaxed ${
                  msg.isMine
                    ? 'bg-[#00ff41]/10 border-[#00ff41]/50 text-[#00ff41] shadow-[0_0_15px_rgba(0,255,65,0.1)]'
                    : msg.isSystem
                      ? 'bg-transparent border-dashed border-[#00ff41]/30 text-[#00ff41]/70'
                      : 'bg-black border-[#00ff41]/30 text-[#00ff41]/90'
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-5 bg-[#0a0a0a] border-t border-[#00ff41]/30">
          <form onSubmit={handleSendMessage} className="flex gap-4 items-center">
            <button
              type="button"
              onClick={handleAttachFile}
              title="Dosya Seç ve Gönder"
              className="p-3 bg-black border border-[#00ff41]/30 text-[#00ff41] hover:bg-[#00ff41]/20 hover:border-[#00ff41] transition-all group"
            >
              <Paperclip className="w-5 h-5 group-hover:drop-shadow-[0_0_5px_rgba(0,255,65,1)]" />
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                activeTab.isGroup
                  ? '> Gruba payload girin...'
                  : `> ${activeTab.title} kullanıcısına özel mesaj...`
              }
              className="flex-1 bg-black border border-[#00ff41]/30 p-3 text-[#00ff41] placeholder-[#00ff41]/30 focus:outline-none focus:border-[#00ff41] focus:shadow-[0_0_10px_rgba(0,255,65,0.2)] transition-all font-mono"
            />

            <button
              type="submit"
              className="px-8 py-3 bg-[#00ff41] text-black font-bold flex items-center gap-2 hover:bg-[#33ff66] hover:shadow-[0_0_20px_rgba(0,255,65,0.5)] transition-all"
            >
              <Send className="w-4 h-4" />
              <span className="tracking-widest">İLET</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}