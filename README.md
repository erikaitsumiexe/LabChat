<div align="center">

# 🛡️ LabChat

**Merkezi Sunucusuz, Uçtan Uca Şifreli Yerel Ağ (LAN) P2P İletişim ve Dosya Paylaşım Uygulaması**  
*Serverless, End-to-End Encrypted Local Area Network (LAN) P2P Messaging & File Sharing Application*

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Rust](https://img.shields.io/badge/Backend-Rust-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/Frontend-React_18_%2B_TypeScript-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Crypto](https://img.shields.io/badge/E2EE-X25519_%2B_ChaCha20--Poly1305_%2B_BLAKE3-10B981?style=flat-square)](#)

[🇹🇷 Türkçe Dokümantasyon](#-türkçe-dokümantasyon) • [🇬🇧 English Documentation](#-english-documentation)

</div>

---

## 🇹🇷 Türkçe Dokümantasyon

### 1. Proje Özeti ve Sunucusuz P2P Mimarisi

**LabChat**, laboratuvar, ofis veya kapalı yerel ağ (LAN) ortamlarında internet bağlantısına ya da merkezi bir sunucuya ihtiyaç duymadan güvenli mesajlaşma ve yüksek hızlı dosya aktarımı sağlamak üzere **Tauri v2** (Rust backend + React/TypeScript frontend) altyapısıyla geliştirilmiş masaüstü uygulamasıdır.

- **Tam Dağıtık Düğüm (Peer-to-Peer) Yapısı:** Ağdaki her istemci aynı zamanda kendi UDP ve TCP portlarını dinleyen bağımsız bir düğüm (node) olarak çalışır. Tek bir hata noktası (Single Point of Failure) yoktur.
- **Sıfır Yapılandırma (Zero-Config):** IP adresi girme veya sunucu kurma gereksinimi olmadan, aynı yerel ağa ve oda parolasına sahip cihazlar saniyeler içinde birbirini otomatik olarak keşfeder.

---

### 2. Backend Teknik Altyapısı ve Kriptografi

LabChat, ağ üzerindeki tüm trafiği hem kimlik doğrulama hem de gizlilik açısından modern kriptografik ilkelerle korur:

#### 📡 Otomatik Ağ Keşfi (UDP Discovery — Port `54321`)
- Cihazlar yerel ağa periyodik UDP broadcast paketleri göndererek varlıklarını duyurur.
- Bu yayınlar sırasında düğümlerin kimlik bilgileri, IP adresleri ve **X25519 açık anahtarları (Public Key)** otomatik olarak takas edilir.
- Belirli bir süre sinyal alınamayan düğümler otomatik olarak **çevrimdışı (offline)** durumuna çekilir; çevrimdışı olan kullanıcılara gönderilen mesajlar kuyruğa alınarak cihaz tekrar ağa bağlandığında otomatik iletilir.

#### 🔐 Uçtan Uca Şifreleme (E2EE — X25519 + ChaCha20-Poly1305 + BLAKE3)
- **Grup Kanalı (`# BROADCAST_ALL`):** Oda parolasından `BLAKE3` kriptografik özet fonksiyonu ile türetilen simetrik oda anahtarı kullanılır. Tüm grup paketleri `ChaCha20-Poly1305` AEAD algoritması ile şifrelenir ve bütünlüğü doğrulanır.
- **Özel Mesajlaşma (DM — X25519 ECDH):** İki kullanıcı arasındaki özel sohbetlerde, cihazların X25519 anahtar çiftlerinden elde edilen **ortak sır (Shared Secret)** ile oda anahtarı `BLAKE3` üzerinden birleştirilerek yalnızca o iki cihaza özgü oturum anahtarı türetilir. *Aynı oda parolasına sahip diğer kullanıcılar dahi ağ trafiğini dinleyerek DM içeriklerini çözemez.*

#### 🔌 TCP Veri İletimi (Port `54322`)
- Metin mesajları, ikili (binary) dosya transferleri, panodan yapıştırılan görseller ve kontrol paketleri (`ACK`, `Read`, `AdminAction`) şifreli TCP akışı üzerinden güvenilir biçimde iletilir.

#### 📬 4 Aşamalı Mesaj Durum Takibi (Delivery & Read Receipts)
Gönderilen her mesaj ve dosya, yaşam döngüsü boyunca arayüzde 4 farklı durum ikonu ile izlenir:
1. **`queued` (Saat İkonu):** Hedef cihaz o an çevrimdışıdır; paket yerel kuyrukta bekletilir ve karşı taraf ağa katıldığı anda otomatik gönderilir.
2. **`sent` (Tek Gri Tik):** Paket gönderici düğümden şifrelenerek TCP akışına başarıyla iletildi.
3. **`delivered` (Çift Gri Tik):** Alıcı düğüm paketi aldı, şifresini çözdü ve göndericiye `message-ack` onayı döndürdü.
4. **`read` (Çift Yeşil Tik):** Alıcı ilgili özel sohbet sekmesini açarak mesajı görüntüledi ve `message-read` okundu bilgisi gönderildi.

---

### 3. Frontend Özellikleri ve Kullanıcı Deneyimi (UI/UX)

React 18, TypeScript, Tailwind CSS ve Lucide ikon seti ile modern karanlık tema (`#09090b`) üzerine inşa edilen arayüz, geliştirici ve laboratuvar iş akışlarına uygun üretkenlik araçları sunar:

- **Çoklu Sekme Mimarisi:** Sabit `# BROADCAST_ALL` genel kanalının yanında her kullanıcı için bağımsız, okunmamış mesaj bildirim noktalı özel mesaj (DM) sekmeleri ve aktif sekmede `X25519 E2EE Aktif` güvenlik rozeti.
- **Sürükle-Bırak (Drag & Drop) Dosya Transferi:** İşletim sisteminden uygulama penceresine sürüklenen tekli veya çoklu dosyalar Tauri Webview dinleyicisi ile yakalanarak aktif kanala doğrudan gönderilir.
- **Panodan Anında Görsel Yapıştırma (`Ctrl + V`):** Ekran görüntüsü araçlarıyla kopyalanan görseller doğrudan mesaj kutusuna yapıştırılabilir; gönderim öncesi küçük önizleme ve boyut bilgisi gösterilir.
- **Dahili Dosya Okuyucu ve Önizleme Modalı:** Sohbet akışındaki görseller (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) yakınlaştırma (`%100 / Sığdır`) desteğiyle; metin ve kod dosyaları (`.txt`, `.log`, `.md`, `.json`, `.csv`, `.xml`, `.yml`) ise sözdizimi dostu önizleyici ve tek tıkla kopyalama butonlarıyla uygulama içinden açılır.
- **Kod Bloğu Algılama (Code Snippet Formatting):** Çok satırlı veya backtick (`` ` `` / ```` ``` ````) içeren mesajlar otomatik olarak monospace kod bloğu olarak biçimlendirilir.
- **Kişi Yönetimi (Üç Nokta `...` ve Sağ Tık Menüsü):** Sol kenar çubuğundaki cihaz listesinde hem `...` butonu hem de sağ tık bağlam menüsü üzerinden:
  - **Sustur / Sesi Aç:** Yerel olarak kullanıcıyı susturma ve adının yanında sessiz (`BellOff`) göstergesi.
  - **Sohbeti ve Kişiyi Sil:** Cihazı listeden kaldırma ve yerel sohbet geçmişini temizleme.
- **Şifre Korumalı Admin Moderasyon Paneli:** Yönetici parolasıyla doğrulanan modal üzerinden ağdaki aktif kullanıcılar **Susturulabilir (`mute` / `unmute`)** veya odadan **Yasaklanabilir (`ban`)**. Yasaklanan kullanıcılar anında oturumdan çıkarılır; susturulan kullanıcılara üst çubukta bilgilendirme rozeti gösterilir.
- **Hızlı Geçiş Komut Paleti (`Ctrl + K`) & Slash Komutları:** Klavyeden ayrılmadan cihazlar/sekmeler arası geçiş yapma; `/clear` ile aktif sohbet geçmişini temizleme ve `/help` ile kısayol listesini görüntüleme.

---

### 4. Proje Yapısı

```text
LabChat/
├── src/                        # React + TypeScript Frontend
│   ├── services/
│   │   └── bridge.ts           # Tauri invoke & event listener köprüsü
│   ├── App.tsx                 # Ana arayüz, sekmeler, modallar ve durum yönetimi
│   └── main.tsx                # Uygulama giriş noktası
├── src-tauri/                  # Rust Backend (Tauri v2)
│   ├── src/
│   │   ├── main.rs / lib.rs    # Tauri komutları ve uygulama yaşam döngüsü
│   │   ├── network/            # UDP (54321) keşif ve TCP (54322) aktarım katmanı
│   │   └── crypto/             # X25519, ChaCha20-Poly1305 ve BLAKE3 işlemleri
│   └── Cargo.toml              # Rust bağımlılıkları
└── package.json                # Node.js bağımlılıkları ve betikler
```

---

### 5. Kurulum ve Çalıştırma

#### Gereksinimler
- **Node.js** (v18 veya üzeri) ve **npm**
- **Rust & Cargo** (Tauri v2 derlemesi için)
- **Güvenlik Duvarı (Firewall):** Yerel ağ keşfi ve veri aktarımı için **UDP `54321`** ve **TCP `54322`** portlarına yerel ağda izin verilmelidir.

#### Geliştirme Ortamında Çalıştırma
```bash
# 1. Depoyu klonlayın
git clone https://github.com/<kullanici-adi>/LabChat.git
cd LabChat

# 2. Frontend bağımlılıklarını yükleyin
npm install

# 3. Tauri masaüstü uygulamasını geliştirme modunda başlatın
npm run tauri dev
```

#### Üretim Derlemesi (Production Build)
```bash
npm run tauri build
```

---
---

## 🇬🇧 English Documentation

### 1. Project Overview & Serverless P2P Architecture

**LabChat** is a serverless, peer-to-peer (P2P) desktop messaging and file-sharing application built with **Tauri v2** (Rust backend + React/TypeScript frontend). Designed for laboratories, offices, and isolated Local Area Networks (LAN), it operates with zero external servers or internet dependency.

- **Decentralized Node Architecture:** Every client acts as an autonomous peer node listening on its own UDP and TCP sockets, eliminating any central server or single point of failure.
- **Zero-Configuration Discovery:** Devices on the same subnet using the same room password automatically discover one another without manual IP configuration.

---

### 2. Backend Architecture & Cryptography

LabChat enforces end-to-end encryption and authenticated transport across all LAN traffic:

#### 📡 Automatic Peer Discovery (UDP Discovery — Port `54321`)
- Nodes broadcast periodic UDP discovery packets across the local subnet to announce presence and exchange **X25519 Public Keys**.
- Peers that stop heartbeating are seamlessly marked **offline**; messages addressed to offline peers are queued locally and flushed automatically once the peer reconnects.

#### 🔐 End-to-End Encryption (E2EE — X25519 + ChaCha20-Poly1305 + BLAKE3)
- **Group Broadcast (`# BROADCAST_ALL`):** Encrypted using a symmetric room key derived from the shared room password via `BLAKE3` and authenticated with `ChaCha20-Poly1305` AEAD.
- **Direct Messages (DM — X25519 ECDH):** Derives a unique pairwise session key by combining the two peers' **X25519 shared secret** with the room key through `BLAKE3`. *Even other members in the same room who know the room password cannot decrypt private DM traffic.*

#### 🔌 TCP Data Transport (Port `54322`)
- Delivers encrypted text payloads, binary file transfers, pasted clipboard images, and control packets (`ACK`, `Read`, `AdminAction`) over reliable TCP streams.

#### 📬 4-Stage Message Delivery & Read Receipts
Every outgoing message and file tracks its real-time state with four distinct indicators:
1. **`queued` (Clock Icon):** Recipient is currently offline; payload is held in the outbound queue for automatic delivery upon reconnection.
2. **`sent` (Single Gray Check):** Encrypted payload successfully dispatched over the TCP stream.
3. **`delivered` (Double Gray Check):** Recipient node received and decrypted the payload, returning a `message-ack` confirmation.
4. **`read` (Double Emerald Check):** Recipient opened the corresponding DM tab, triggering a `message-read` receipt.

---

### 3. Frontend Features & User Experience (UI/UX)

Built with React 18, TypeScript, Tailwind CSS, and Lucide icons in a sleek dark interface (`#09090b`):

- **Tabbed Workspace:** Persistent `# BROADCAST_ALL` channel alongside dynamic per-peer DM tabs with unread indicators and an `X25519 E2EE Aktif` security badge.
- **Drag & Drop File Sharing:** Drop single or multiple files anywhere onto the application window to immediately dispatch them to the active channel or DM.
- **Clipboard Image Paste (`Ctrl + V`):** Paste screenshots directly from the clipboard with an inline thumbnail and file-size preview bar prior to sending.
- **Built-in File Reader & Preview Modal:** Inspect images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) with `100% / Fit` zoom toggling, and read text/code files (`.txt`, `.log`, `.md`, `.json`, `.csv`, `.xml`, `.yml`) with one-click copy support directly inside the app.
- **Automatic Code Snippet Formatting:** Multi-line messages and backtick-fenced snippets render in dedicated monospace blocks with hover-to-copy buttons.
- **Peer Context & Three-Dot Menu (`...`):** Mute/unmute peers locally (`BellOff` indicator) or remove peers and clear their local conversation history via right-click or the action menu.
- **Password-Protected Admin Moderation Panel:** Authenticate with the admin password to **Mute/Unmute** or **Ban** active network peers in real time, complete with live `admin-notice` enforcement banners.
- **Command Palette (`Ctrl + K`) & Slash Commands:** Fast keyboard navigation across peers, tabs, and actions, plus built-in `/clear` and `/help` commands.

---

### 4. Project Structure

```text
LabChat/
├── src/                        # React + TypeScript Frontend
│   ├── services/
│   │   └── bridge.ts           # Typed Tauri invoke & event listener bridge
│   ├── App.tsx                 # Main UI, tabs, modals, and state management
│   └── main.tsx                # Application entry point
├── src-tauri/                  # Rust Backend (Tauri v2)
│   ├── src/
│   │   ├── main.rs / lib.rs    # Tauri command handlers & app lifecycle
│   │   ├── network/            # UDP (54321) discovery & TCP (54322) transport
│   │   └── crypto/             # X25519, ChaCha20-Poly1305 & BLAKE3 primitives
│   └── Cargo.toml              # Rust dependencies
└── package.json                # Node.js dependencies & scripts
```

---

### 5. Installation & Running

#### Prerequisites
- **Node.js** (v18+) and **npm**
- **Rust & Cargo** (required for Tauri v2)
- **Firewall Configuration:** Allow local subnet traffic on **UDP `54321`** and **TCP `54322`**.

#### Run in Development Mode
```bash
# 1. Clone the repository
git clone https://github.com/<username>/LabChat.git
cd LabChat

# 2. Install frontend dependencies
npm install

# 3. Launch the Tauri desktop app
npm run tauri dev
```

#### Build for Production
```bash
npm run tauri build
```