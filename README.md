# Nyra Mirror 🪞
> Dual WhatsApp Remote Cloud Monitor & 5 TB Google Drive Media Vault.

---

## 🌟 Architecture

```
[ WhatsApp Account 1 ] ──┐
                         ├──► [ Nyra Mirror Gateway (24/7 GitHub Actions Cloud) ]
[ WhatsApp Account 2 ] ──┘         │
                                   ▼ (Encrypted Webhook & Media Stream)
                        [ Nyra Mirror Brain (Cloudflare Pages Worker) ]
                         ├── 🗄️ Cloudflare D1 Database (Partitioned Chat History)
                         ├── 📦 Cloudflare R2 Bucket (Dual Session Encryption)
                         └── ☁️ Google Drive 5 TB Vault (Photos, Videos, Audio)
                                   │
                                   ▼
                        [ Web Dashboard: nyra-mirror.pages.dev ]
                         ├── 🔐 Email & Password Protection
                         ├── 📱 Dual QR Code Linker (#1 & #2)
                         ├── 💬 Remote Conversation Viewer & Switcher
                         └── ☁️ Google Drive Media Lightbox
```

---

## 🚀 Key Features

* **100% Free Cloud Operation:** Gateway runs 24/7 on GitHub Actions Linux runners; frontend & API run on Cloudflare Pages.
* **Dual WhatsApp Support:** Connect two WhatsApp accounts simultaneously with live QR code pairing.
* **Remote Conversations Viewer:** Switch between Account 1 and Account 2 in real-time, browse chats, and view messages.
* **5 TB Google Drive Vault:** Images, videos, voice notes, and documents are automatically uploaded to your Google Drive.
* **Encrypted Multi-Device Persistence:** Multi-device WhatsApp sessions are encrypted with AES-256-GCM and stored in Cloudflare R2, preventing disconnections on runner restarts.
* **Completely Independent:** Has its own separate URL (`nyra-mirror.pages.dev`) and login credentials.
