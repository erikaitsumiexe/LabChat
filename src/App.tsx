import { useState, useEffect, FormEvent } from 'react';
import { Terminal, Users, Send, Paperclip, Lock, ShieldAlert, Wifi, Key } from 'lucide-react';
import { UnlistenFn } from '@tauri-apps/api/event';
import { bridge, Peer, ReceivedMessage } from './services/bridge';
import "./index.css";

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<(ReceivedMessage & { isMine?: boolean })[]>([]);
  const [inputText, setInputText] = useState('');

  useEffect(() => {
    if (!isLoggedIn) return;

    let unlistenPeers: UnlistenFn | undefined;
    let unlistenMessages: UnlistenFn | undefined;

    const setupListeners = async () => {
      try {
        const peersListener = await bridge.onPeersUpdated((updatedPeers) => {
          setPeers(updatedPeers);
        });
        unlistenPeers = peersListener;

        const messagesListener = await bridge.onMessageReceived((msg) => {
          setMessages((prev) => [...prev, { ...msg, isMine: false }]);
        });
        unlistenMessages = messagesListener;
      } catch (error) {
        console.error("Listener başlatılırken hata oluştu:", error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenPeers) unlistenPeers();
      if (unlistenMessages) unlistenMessages();
    };
  }, [isLoggedIn]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomPassword.trim()) return;

    try {
      await bridge.joinRoom(username, roomPassword);
      setIsLoggedIn(true);
      setMessages([{ sender_id: 'SYSTEM', text: 'Bağlantı kuruldu. Ağ dinleniyor...', timestamp: new Date().toLocaleTimeString(), isMine: false }]);
    } catch (error) {
      console.error("Bağlantı hatası:", error);
      alert("Ağa bağlanılamadı. Arka planı kontrol edin.");
    }
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const newMsg = {
      sender_id: 'Ben',
      text: inputText,
      timestamp: new Date().toLocaleTimeString(),
      isMine: true
    };

    setMessages(prev => [...prev, newMsg]);
    const textToSend = inputText;
    setInputText('');

    try {
      await bridge.sendMessage(null, textToSend);
    } catch (err) {
      console.error("Mesaj gönderilemedi:", err);
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

  return (
    <div className="flex h-screen w-screen bg-[#050505] text-[#00ff41] font-mono">
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
            {peers.length === 0 && <li className="text-xs text-[#00ff41]/40 italic">Ağda kimse yok...</li>}
            {peers.map(peer => (
              <li key={peer.id} className="p-3 border border-[#00ff41]/20 bg-black hover:bg-[#00ff41]/10 hover:border-[#00ff41]/50 transition-colors flex justify-between items-center">
                <div className="font-bold text-[#00ff41]">@{peer.username}</div>
                <span className="w-1.5 h-1.5 rounded-full bg-[#00ff41] shadow-[0_0_5px_#00ff41]"></span>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="p-4 text-[10px] border-t border-[#00ff41]/30 text-[#00ff41]/50 flex items-center justify-between bg-black">
          <span className="tracking-widest">ENCRYPTION: ENABLED</span>
          <Lock className="w-3 h-3 text-[#00ff41]" />
        </div>
      </div>

      <div className="flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#0a0a0a] to-[#050505]">
        <div className="h-16 border-b border-[#00ff41]/30 flex items-center px-6 bg-[#0a0a0a]/80 justify-between">
          <div>
            <div className="font-bold text-sm tracking-wider drop-shadow-[0_0_5px_rgba(0,255,65,0.3)]">{'>'} TARGET: BROADCAST_ALL</div>
            <div className="text-[10px] text-[#00ff41]/40 uppercase tracking-widest mt-1">P2P TUNNEL ESTABLISHED</div>
          </div>
          <div className="text-xs text-[#00ff41]/60 bg-[#00ff41]/10 px-3 py-1 border border-[#00ff41]/30">USER: {username}</div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex flex-col ${msg.isMine ? 'items-end' : 'items-start'}`}>
              <div className="text-[10px] text-[#00ff41]/50 mb-1 flex gap-2 tracking-widest">
                {!msg.isMine && (
                  <span className="font-bold text-[#00ff41]/80">
                    {msg.sender_id === 'SYSTEM' ? '[SYSTEM]' : `@${msg.sender_id}`}
                  </span>
                )}
                <span>[{msg.timestamp}]</span>
              </div>
              <div className={`px-4 py-2.5 max-w-[75%] border break-all text-sm leading-relaxed ${
                msg.isMine 
                  ? 'bg-[#00ff41]/10 border-[#00ff41]/50 text-[#00ff41] shadow-[0_0_15px_rgba(0,255,65,0.1)]' 
                  : msg.sender_id === 'SYSTEM' 
                    ? 'bg-transparent border-dashed border-[#00ff41]/30 text-[#00ff41]/70'
                    : 'bg-black border-[#00ff41]/30 text-[#00ff41]/90'
              }`}>
                {msg.text}
              </div>
            </div>
          ))}
        </div>

        <div className="p-5 bg-[#0a0a0a] border-t border-[#00ff41]/30">
          <form onSubmit={handleSendMessage} className="flex gap-4 items-center">
            <button 
              type="button"
              className="p-3 bg-black border border-[#00ff41]/30 text-[#00ff41] hover:bg-[#00ff41]/20 hover:border-[#00ff41] transition-all group"
            >
              <Paperclip className="w-5 h-5 group-hover:drop-shadow-[0_0_5px_rgba(0,255,65,1)]" />
            </button>
            
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="> Payload girin..."
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
