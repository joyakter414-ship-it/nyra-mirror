// Nyra Mirror — Dual WhatsApp Web Client

let activeTab = "devices";
let activeAccount = "acc1";
let activeChatId = null;
let currentChats = [];
let statusPollTimer = null;
let chatPollTimer = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── App Initialization ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await checkAuth();
});

// ─── Authentication ──────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch("/api/session");
    const data = await res.json();
    if (data.authenticated) {
      showApp(data.email);
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  clearInterval(statusPollTimer);
  clearInterval(chatPollTimer);
  $("#login-section").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

function showApp(email) {
  $("#login-section").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (email) $("#user-email-badge").textContent = email;

  startStatusPolling();
  loadChats();
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
function setupEventListeners() {
  // Login Form
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").textContent = "";
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value.trim();

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.success) {
        showApp(data.email);
      } else {
        $("#login-error").textContent = data.error || "Login failed";
      }
    } catch {
      $("#login-error").textContent = "Unable to connect to server";
    }
  });

  // Logout
  $("#logout-btn").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    showLogin();
  });

  // Tab Navigation
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeTab = btn.dataset.tab;

      $$(".page-section").forEach((sec) => sec.classList.add("hidden"));
      $(`#tab-${activeTab}`).classList.remove("hidden");

      if (activeTab === "chats") {
        loadChats();
      }
    });
  });

  // Account Switcher in Conversations
  $("#switch-acc1").addEventListener("click", () => switchAccount("acc1"));
  $("#switch-acc2").addEventListener("click", () => switchAccount("acc2"));

  // Chat Search
  $("#chat-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    renderChatList(
      currentChats.filter(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.notify_name && c.notify_name.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)) ||
          (c.chat_id && c.chat_id.includes(q))
      )
    );
  });

  // Disconnect Buttons
  $("#disconnect-btn-acc1").addEventListener("click", () => disconnectAccount("acc1"));
  $("#disconnect-btn-acc2").addEventListener("click", () => disconnectAccount("acc2"));

  // WhatsApp Chat Reply Form
  const replyForm = $("#chat-reply-form");
  if (replyForm) {
    replyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("#chat-reply-input");
      const text = input.value.trim();
      if (!text || !activeChatId) return;

      input.value = "";

      // Optimistically append outgoing message to chat immediately
      const container = $("#messages-container");
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble msg-out";
      bubble.innerHTML = `
        <div class="msg-text">${escapeHtml(text)}</div>
        <div class="msg-meta">
          <span>${formatTimestamp(new Date().toISOString())}</span>
          <span class="wa-ticks">✓</span>
        </div>
      `;
      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;

      try {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: activeAccount,
            chat: activeChatId,
            text,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          console.error("Failed to send message:", data.error);
        } else {
          setTimeout(loadMessages, 1200);
        }
      } catch (err) {
        console.error("Send error:", err);
      }
    });
  }

  // Lightbox Close
  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#lightbox-modal").addEventListener("click", (e) => {
    if (e.target === $("#lightbox-modal")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
}

// ─── Dual Status & QR Polling ────────────────────────────────────────────────
function startStatusPolling() {
  fetchStatus();
  statusPollTimer = setInterval(fetchStatus, 3000);
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) {
      if (res.status === 401) showLogin();
      return;
    }
    const data = await res.json();
    updateDeviceUI("acc1", data.acc1);
    updateDeviceUI("acc2", data.acc2);
  } catch (err) {
    console.error("Status fetch error:", err);
  }
}

function updateDeviceUI(accId, status) {
  const badge = $(`#status-badge-${accId}`);
  const infoBox = $(`#info-box-${accId}`);
  const qrBox = $(`#qr-box-${accId}`);
  const qrImg = $(`#qr-img-${accId}`);
  const qrLoader = $(`#qr-loader-${accId}`);
  const phone = $(`#phone-${accId}`);
  const name = $(`#name-${accId}`);
  const disBtn = $(`#disconnect-btn-${accId}`);
  const switchPhone = $(`#switch-phone-${accId}`);

  if (!status) return;

  badge.className = "status-pill";

  if (status.state === "connected") {
    badge.classList.add("status-connected");
    badge.textContent = "🟢 Connected";
    infoBox.classList.remove("hidden");
    qrBox.classList.add("hidden");
    disBtn.classList.remove("hidden");

    const phoneNum = status.me?.pn ? `+${status.me.pn.replace(/@.*$/, "")}` : "Connected";
    phone.textContent = phoneNum;
    name.textContent = status.me?.name || status.me?.notify || "WhatsApp User";
    switchPhone.textContent = phoneNum;
  } else if (status.state === "qr" && status.qr) {
    badge.classList.add("status-waiting");
    badge.textContent = "🟡 Scan QR Code";
    infoBox.classList.add("hidden");
    qrBox.classList.remove("hidden");
    qrLoader.classList.add("hidden");
    qrImg.src = status.qr;
    qrImg.style.display = "block";
    disBtn.classList.add("hidden");
    switchPhone.textContent = "Waiting QR";
  } else if (status.state === "connecting" || status.state === "starting") {
    badge.classList.add("status-waiting");
    badge.textContent = "⏳ Connecting...";
    infoBox.classList.add("hidden");
    qrBox.classList.remove("hidden");
    qrImg.style.display = "none";
    qrLoader.classList.remove("hidden");
    qrLoader.textContent = "Connecting to WhatsApp...";
    disBtn.classList.add("hidden");
    switchPhone.textContent = "Connecting";
  } else {
    badge.classList.add("status-disconnected");
    badge.textContent = "🔴 Disconnected";
    infoBox.classList.add("hidden");
    qrBox.classList.remove("hidden");
    qrImg.style.display = "none";
    qrLoader.classList.remove("hidden");
    qrLoader.textContent = "Gateway Offline / Waiting";
    disBtn.classList.add("hidden");
    switchPhone.textContent = "--";
  }
}

async function disconnectAccount(accId) {
  if (!confirm(`Are you sure you want to disconnect WhatsApp Account ${accId === "acc1" ? "1" : "2"}?`)) return;
  try {
    await fetch("/api/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: accId }),
    });
    fetchStatus();
  } catch (err) {
    alert("Error disconnecting account: " + err.message);
  }
}

// ─── Conversations (Dual Account Switching & Chat List) ──────────────────────
function switchAccount(accId) {
  if (activeAccount === accId) return;
  activeAccount = accId;

  $("#switch-acc1").classList.toggle("active", accId === "acc1");
  $("#switch-acc2").classList.toggle("active", accId === "acc2");
  $("#active-acc-label").textContent = accId === "acc1" ? "WhatsApp 1" : "WhatsApp 2";
  $("#chat-account-indicator").textContent = accId === "acc1" ? "WhatsApp 1" : "WhatsApp 2";

  activeChatId = null;
  resetChatPane();
  loadChats();
}

async function loadChats() {
  const container = $("#conversations-list");
  try {
    const res = await fetch(`/api/chats?account=${activeAccount}`);
    if (!res.ok) return;
    const data = await res.json();
    currentChats = data.chats || [];
    renderChatList(currentChats);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Error loading chats</div>`;
  }
}

function renderChatList(chats) {
  const container = $("#conversations-list");
  if (!chats || chats.length === 0) {
    container.innerHTML = `<div class="empty-state">No conversations found for ${activeAccount === "acc1" ? "WhatsApp 1" : "WhatsApp 2"}</div>`;
    return;
  }

  container.innerHTML = "";
  chats.forEach((chat) => {
    const item = document.createElement("div");
    item.className = "chat-item";
    if (chat.chat_id === activeChatId) item.classList.add("active");

    const displayName = chat.name || chat.notify_name || formatPhone(chat.phone) || chat.chat_id.replace(/@.*$/, "");
    const initials = getInitials(displayName);
    const avatarColor = getAvatarColor(displayName || initials);
    const timeStr = formatTimestamp(chat.last_at);

    item.innerHTML = `
      <div class="chat-item-avatar" style="background: ${avatarColor};">
        ${chat.avatar_url ? `<img src="${escapeHtml(chat.avatar_url)}" alt="" />` : initials}
      </div>
      <div class="chat-item-content">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(displayName)}</span>
          <span class="chat-item-time">${timeStr}</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-snippet">${escapeHtml(chat.last_msg || "No messages yet")}</span>
          ${chat.unread > 0 ? `<span class="unread-badge">${chat.unread}</span>` : ""}
        </div>
      </div>
    `;

    item.addEventListener("click", () => selectChat(chat));
    container.appendChild(item);
  });
}

function selectChat(chat) {
  activeChatId = chat.chat_id;
  $$(".chat-item").forEach((el) => el.classList.remove("active"));

  const displayName = chat.name || chat.notify_name || formatPhone(chat.phone) || chat.chat_id.replace(/@.*$/, "");
  $("#chat-contact-name").textContent = displayName;
  $("#chat-contact-phone").textContent = formatPhone(chat.phone) || chat.chat_id;

  const avatar = $("#chat-avatar");
  const avatarColor = getAvatarColor(displayName);
  avatar.style.background = avatarColor;
  if (chat.avatar_url) {
    avatar.innerHTML = `<img src="${escapeHtml(chat.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;" />`;
  } else {
    avatar.textContent = getInitials(displayName);
  }

  // Show WhatsApp chat reply form
  const replyForm = $("#chat-reply-form");
  if (replyForm) {
    replyForm.classList.remove("hidden");
    $("#chat-reply-input")?.focus();
  }

  loadMessages();
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(loadMessages, 3000);
}

function resetChatPane() {
  clearInterval(chatPollTimer);
  $("#chat-contact-name").textContent = "Select a conversation";
  $("#chat-contact-phone").textContent = "Pick a chat from the left to view messages";
  $("#chat-avatar").textContent = "WA";
  $("#chat-avatar").style.background = "#334155";
  $("#messages-container").innerHTML = `<div class="empty-chat-state">No conversation selected</div>`;
  $("#chat-reply-form")?.classList.add("hidden");
}

async function loadMessages() {
  if (!activeChatId) return;
  const container = $("#messages-container");

  try {
    const res = await fetch(`/api/messages?account=${activeAccount}&chatId=${encodeURIComponent(activeChatId)}`);
    if (!res.ok) return;
    const data = await res.json();
    renderMessages(data.messages || []);
  } catch (err) {
    console.error("Messages load error:", err);
  }
}

// ─── Render Messages with Authentic WhatsApp In-Chat Media Experience ────────
function renderMessages(messages) {
  const container = $("#messages-container");
  if (!messages || messages.length === 0) {
    container.innerHTML = `<div class="empty-chat-state">No messages in this chat</div>`;
    return;
  }

  const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 120;

  container.innerHTML = "";
  messages.forEach((m) => {
    const bubble = document.createElement("div");
    const isOut = m.role === "assistant";
    bubble.className = `msg-bubble ${isOut ? "msg-out" : "msg-in"}`;

    // Quoted reply box (replies rendered neatly inside bubble)
    let quotedHtml = "";
    if (m.quoted_text) {
      quotedHtml = `
        <div class="msg-quoted">
          <div class="msg-quoted-sender">${escapeHtml(m.quoted_sender || "Reply")}</div>
          <div class="msg-quoted-text">${escapeHtml(m.quoted_text)}</div>
        </div>
      `;
    }

    // Media rendered 100% inside the chat bubble (like real WhatsApp on phone!)
    let mediaHtml = "";
    if (m.media_url || m.media_id) {
      const mediaSrc = m.media_url || `/api/media/${m.media_id}`;

      if (m.media_type === "image" || m.media_type === "sticker") {
        mediaHtml = `
          <div class="wa-image-box">
            <img src="${escapeHtml(mediaSrc)}" alt="Photo" onclick="openLightbox('${escapeHtml(mediaSrc)}')" loading="lazy" />
          </div>
        `;
      } else if (m.media_type === "audio") {
        mediaHtml = `
          <div class="wa-voice-bubble">
            <div class="wa-voice-mic">🎤</div>
            <div class="wa-voice-player">
              <audio controls preload="metadata" src="${escapeHtml(mediaSrc)}"></audio>
            </div>
          </div>
        `;
      } else if (m.media_type === "video") {
        mediaHtml = `
          <div class="wa-video-box">
            <video controls preload="metadata" src="${escapeHtml(mediaSrc)}"></video>
          </div>
        `;
      } else if (m.media_type === "document") {
        mediaHtml = `
          <a href="${escapeHtml(mediaSrc)}" target="_blank" download class="wa-doc-box">
            <div class="wa-doc-icon">📄</div>
            <div class="wa-doc-info">
              <div class="wa-doc-name">${escapeHtml(m.content || "Document")}</div>
              <div class="wa-doc-sub">Tap to download / view</div>
            </div>
            <div class="wa-doc-arrow">⬇️</div>
          </a>
        `;
      }
    }

    const senderLabel = !isOut && m.sender_name ? `<span class="msg-sender">${escapeHtml(m.sender_name)}</span>` : "";

    const isPlaceholder =
      m.media_type &&
      (m.content === `[${m.media_type.toUpperCase()}]` ||
        m.content === "🎤 Voice message" ||
        m.content === "🎵 Audio" ||
        m.content === "🎥 Video");

    bubble.innerHTML = `
      ${senderLabel}
      ${quotedHtml}
      ${mediaHtml}
      ${m.content && !isPlaceholder ? `<div class="msg-text">${escapeHtml(m.content)}</div>` : ""}
      <div class="msg-meta">
        <span>${formatTimestamp(m.created_at)}</span>
        ${isOut ? `<span class="wa-ticks">✓✓</span>` : ""}
      </div>
    `;

    container.appendChild(bubble);
  });

  if (isAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

// ─── Lightbox Modal ──────────────────────────────────────────────────────────
function openLightbox(url) {
  $("#lightbox-img").src = url;
  $("#lightbox-modal").classList.remove("hidden");
}

function closeLightbox() {
  $("#lightbox-modal").classList.add("hidden");
  $("#lightbox-img").src = "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getInitials(name) {
  if (!name) return "WA";
  const clean = name.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase() || "WA";
}

function getAvatarColor(str) {
  const colors = [
    "#00a884", "#0284c7", "#059669", "#d97706", "#dc2626", "#7c3aed",
    "#db2777", "#4f46e5", "#0891b2", "#65a30d", "#ea580c"
  ];
  let hash = 0;
  for (let i = 0; i < (str || "WA").length; i++) {
    hash = (str || "WA").charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function formatPhone(p) {
  if (!p) return "";
  const digits = p.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
