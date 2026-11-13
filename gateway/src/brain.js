// REST client to communicate with the Nyra Mirror Cloud Brain on Cloudflare

const BRAIN_URL = (process.env.BRAIN_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.GATEWAY_TOKEN || "";

if (!BRAIN_URL) {
  console.warn("⚠️ BRAIN_URL is not set. Gateway will not be able to relay messages to Cloudflare.");
}

export async function brain(method, path, { body, headers = {}, raw = false } = {}) {
  const url = `${BRAIN_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const reqHeaders = {
    Authorization: `Bearer ${TOKEN}`,
    ...headers,
  };

  let reqBody = body;
  if (body && typeof body === "object" && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
    reqHeaders["Content-Type"] = "application/json";
    reqBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  if (!res.ok) {
    if (res.status === 404 && raw) return null;
    const txt = await res.text().catch(() => "");
    throw new Error(`Brain HTTP ${res.status}: ${txt || res.statusText}`);
  }

  if (raw) {
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  const cType = res.headers.get("content-type") || "";
  if (cType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

export async function updateStatus(accountId, { state, qr, me, error }) {
  return brain("POST", "/api/gateway/update", {
    body: {
      type: "status",
      account_id: accountId,
      state,
      qr,
      me,
      error,
    },
  }).catch((err) => console.error(`[${accountId}] Status update failed:`, err.message));
}

export async function uploadMedia(filename, mime, buffer) {
  return brain("POST", "/api/gateway/media", {
    headers: {
      "Content-Type": "application/octet-stream",
      "x-filename": filename,
      "x-mime": mime,
    },
    body: buffer,
  });
}

export async function recordMessage(accountId, message, chat) {
  return brain("POST", "/api/gateway/update", {
    body: {
      type: "message",
      account_id: accountId,
      message,
      chat,
    },
  }).catch((err) => console.error(`[${accountId}] Message record failed:`, err.message));
}

export async function getOutbound(accountId) {
  try {
    return await brain("GET", `/api/gateway/outbound?account=${accountId}`);
  } catch {
    return null;
  }
}
