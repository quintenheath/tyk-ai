// Signed session tokens - replaces trusting a bare user_id/session_id sent
// straight from the client. Without this, anyone who obtained/guessed a
// UUID could impersonate that identity in every request; a token can only
// be produced by auth-users at login/start-temp-session time (the only place
// that holds SESSION_SECRET) and is verified (signature + expiry) on every
// subsequent call before any id inside it is trusted.
const ALGORITHM = { name: "HMAC", hash: "SHA-256" };
const TOKEN_TTL_MS = {
  user: 12 * 60 * 60 * 1000, // 12h - persistent users re-authenticate periodically
  session: 24 * 60 * 60 * 1000, // 24h - a temp session still dies on sign-out regardless
};

function getSecret(): string {
  const secret = Deno.env.get("SESSION_SECRET");
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured.");
  }
  return secret;
}

async function getKey() {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    ALGORITHM,
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    str.length + ((4 - (str.length % 4)) % 4),
    "=",
  );
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface SessionPayload {
  type: "user" | "session";
  id: string;
  exp: number;
}

export async function signToken(type: "user" | "session", id: string): Promise<string> {
  const payload: SessionPayload = { type, id, exp: Date.now() + TOKEN_TTL_MS[type] };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await getKey();
  const signature = new Uint8Array(await crypto.subtle.sign(ALGORITHM, key, payloadBytes));
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`;
}

export async function verifyToken(token: unknown): Promise<SessionPayload | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payloadPart, sigPart] = token.split(".");
  try {
    const payloadBytes = base64UrlDecode(payloadPart);
    const signature = base64UrlDecode(sigPart);
    const key = await getKey();
    const valid = await crypto.subtle.verify(ALGORITHM, key, signature, payloadBytes);
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    if (payload.type !== "user" && payload.type !== "session") return null;
    return payload;
  } catch {
    return null;
  }
}
