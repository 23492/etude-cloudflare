// Self-hosted Etude Sync server on Cloudflare Workers + D1 (+ optional R2).
// Implements the subset of etude-cloud's /v1 protocol that Etude's sync client uses
// (src/core/sync/transport.ts, src/core/sync/client.ts, src/core/account.ts), modelled on the
// fake servers in Etude's own tests (test/sync-snapshot.test.ts, test/sync-without-password.test.ts).
//
// Sign-in: no email is sent. The admin creates a personal invite token per person (POST /admin/invites).
// In Etude: Settings → Sync → server URL, enter your email, then paste the invite token where the
// app asks for the code. Etude sends it as a link token ({token}) to /v1/auth/email/verify.
//
// Blob storage: R2 when the BLOBS binding exists, otherwise chunked rows in D1 (blob_chunks).

const QUOTA_BYTES = 2 * 1024 ** 3;
const CHUNK = 1024 * 1024; // D1 fallback chunk size (D1 max row/value is 2 MB)
const PAGE_MAX = 1000;
const PAGE_BYTES = 1024 * 1024; // smaller than etude-cloud (8 MiB) to stay inside the free plan CPU budget
const BLOB_NAME = /^[a-f0-9]{64}$/;

const enc = new TextEncoder();
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function cors(env, req) {
  const origin = req.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
    "Access-Control-Expose-Headers": "ETag, Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const err = (status, code, message = code) => json(status, { error: { code, message } });

// ---------------------------------------------------------------- blobs
function blobStore(env) {
  if (env.BLOBS) {
    return {
      async put(acct, name, bytes) { await env.BLOBS.put(`${acct}/${name}`, bytes); },
      async get(acct, name) { const o = await env.BLOBS.get(`${acct}/${name}`); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
      async del(acct, name) { await env.BLOBS.delete(`${acct}/${name}`); },
    };
  }
  return {
    async put(acct, name, bytes) {
      const stmts = [env.DB.prepare("DELETE FROM blob_chunks WHERE account_id=? AND name=?").bind(acct, name)];
      for (let i = 0, n = 0; i < bytes.length || n === 0; i += CHUNK, n++)
        stmts.push(env.DB.prepare("INSERT INTO blob_chunks (account_id,name,n,data) VALUES (?,?,?,?)").bind(acct, name, n, bytes.subarray(i, i + CHUNK)));
      await env.DB.batch(stmts);
    },
    async get(acct, name) {
      const { results } = await env.DB.prepare("SELECT data FROM blob_chunks WHERE account_id=? AND name=? ORDER BY n").bind(acct, name).all();
      if (!results.length) return null;
      const parts = results.map((r) => new Uint8Array(r.data));
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
    async del(acct, name) { await env.DB.prepare("DELETE FROM blob_chunks WHERE account_id=? AND name=?").bind(acct, name).run(); },
  };
}

// ---------------------------------------------------------------- Cloudflare Access
// When ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, the worker trusts the email in the
// Cf-Access-Jwt-Assertion header after checking its RS256 signature against the team's certs,
// its audience, issuer and expiry. Never trusts an email from anywhere else.
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
let certCache = { at: 0, keys: [] };
async function accessKeys(env, force = false) {
  if (!force && Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`${env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/certs`);
  const { keys = [] } = await r.json();
  certCache = { at: Date.now(), keys };
  return keys;
}
async function verifyAccessJwt(env, jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== "RS256") return null;
  let jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(env, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "")) return null;
  if (typeof payload.exp !== "number" || payload.exp < now - 60) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (!payload.email) return null; // service tokens carry no email
  return String(payload.email).trim().toLowerCase();
}
const accessOn = (env) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
async function accessEmail(env, req) {
  if (!accessOn(env)) return null;
  return verifyAccessJwt(env, req.headers.get("cf-access-jwt-assertion")).catch(() => null);
}

// ---------------------------------------------------------------- auth
async function deviceFor(env, req) {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return null;
  const row = await env.DB.prepare(
    "SELECT d.id AS device_id, d.name AS device_name, d.created_at AS device_created, a.id, a.email, a.display_name, a.created_at FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.token_hash=?",
  ).bind(await sha256(auth)).first();
  if (row) await env.DB.prepare("UPDATE devices SET last_seen=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(row.device_id).run();
  return row;
}

async function accountForEmail(env, email) {
  let a = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(email).first();
  if (!a) {
    const id = "acc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare("INSERT INTO accounts (id,email) VALUES (?,?)").bind(id, email).run();
    await env.DB.prepare("INSERT OR IGNORE INTO vaults (account_id) VALUES (?)").bind(id).run();
    a = await env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
  }
  return a;
}

const meOf = (u) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name || "",
  created: u.created_at,
  device: { id: u.device_id, name: u.device_name || "", via: "invite", created: u.device_created, lastSeen: new Date().toISOString(), current: true },
  sync: { active: true, reason: "self_hosted" },
  creator: null,
  admin: false,
});

async function vaultRow(env, acct) {
  await env.DB.prepare("INSERT OR IGNORE INTO vaults (account_id) VALUES (?)").bind(acct).run();
  return env.DB.prepare("SELECT * FROM vaults WHERE account_id=?").bind(acct).first();
}

// ---------------------------------------------------------------- handler
// ---- House style for every AI answer through this server (grading feedback, the follow-up chat, Minimi).
// Added to the app's own system prompt, so it applies whatever the app version or the person's settings.
// AI_STYLE=off switches it off; AI_STYLE_EXTRA (text) adds a deployment's own lines.
const HOUSE_STYLE = `House style for everything you write for the learner (it overrides any style instruction above; it does not change the facts, the grading or the output format, so JSON stays JSON):
- Short and direct. Answer first, in the first sentence. Then at most two sentences of why. Stop when the point is made.
- Write in the learner's language, the way people speak it. Keep every subject term exactly as the card writes it: terms, feature names and jargon stay in the card's language and spelling. That jargon is what is being learned, so use it literally; never translate it, paraphrase it or swap it for a vaguer word.
- No em dashes or en dashes. Use a period, comma, colon or parentheses.
- No openers, closers or praise ("Great question", "Sure!", "Good job", "I hope this helps", "Let me know"), no recap at the end.
- No filler or hype words (crucial, essential, seamless, powerful, basically, simply, "it is important to", "not only X but also Y", "it's not X, it's Y") and their equivalents in other languages.
- No bold, no headings and no bullet lists unless the learner asks for a list or you compare three or more options.
- Never invent facts, limits, mnemonics or "common mistakes". If you are not sure, say so in one sentence.
- If you speak as Minimi the cat: at most one small cat touch, and only when it is actually funny.`;
function withHouseStyle(messages, extra = "") {
  const style = extra ? `${HOUSE_STYLE}\n${extra}` : HOUSE_STYLE;
  const out = messages.map((x) => ({ ...x }));
  const i = out.findIndex((x) => x.role === "system");
  if (i < 0) return [{ role: "system", content: style }, ...out];
  const c = out[i].content;
  out[i].content = typeof c === "string" ? `${c}\n\n${style}` : Array.isArray(c) ? [...c, { type: "text", text: style }] : style;
  return out;
}
/** Em dash to a comma, en dash to a hyphen; also their JSON escapes, so it works inside raw provider JSON. */
function undash(s) {
  return s
    .replace(/ ?(?:\u2014|\\u2014) ?/g, ", ")
    .replace(/ (?:\u2013|\\u2013) /g, ", ")
    .replace(/\u2013|\\u2013/g, "-");
}
/** The same on a server-sent-events stream, line by line (a line never splits a JSON string). */
function dashFilter() {
  const dec = new TextDecoder(), enc2 = new TextEncoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const cut = buf.lastIndexOf("\n");
      if (cut < 0) return;
      ctl.enqueue(enc2.encode(undash(buf.slice(0, cut + 1))));
      buf = buf.slice(cut + 1);
    },
    flush(ctl) {
      buf += dec.decode();
      if (buf) ctl.enqueue(enc2.encode(undash(buf)));
    },
  });
}

async function handle(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (p === "/health") return json(200, { ok: true, service: "etude-sync" });

  // ---- the Etude web app (Workers Static Assets), same origin as Sync
  if (!p.startsWith("/v1/") && !p.startsWith("/admin/")) {
    if (p === "/") return Response.redirect(new URL("/app/", url).toString(), 302);
    if (!env.ASSETS) return err(404, "not_found");
    const res = await env.ASSETS.fetch(req);
    if (res.status === 404 && p.startsWith("/app") && m === "GET") return env.ASSETS.fetch(new Request(new URL("/app/index.html", url), req));
    return res;
  }

  // ---- admin (operator only): invites
  if (p.startsWith("/admin/")) {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.ADMIN_TOKEN || !timingSafeEqual(t, env.ADMIN_TOKEN)) return err(401, "unauthorized");
    if (p === "/admin/invites" && m === "POST") {
      const { email } = await req.json();
      if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return err(400, "invalid_email");
      const token = randomToken("inv_");
      await env.DB.prepare("INSERT INTO invites (token_hash,email) VALUES (?,?)").bind(await sha256(token), email.trim().toLowerCase()).run();
      return json(201, { email: email.trim().toLowerCase(), token });
    }
    if (p === "/admin/invites" && m === "GET") {
      const { results } = await env.DB.prepare("SELECT email, created_at, revoked FROM invites ORDER BY created_at").all();
      return json(200, { invites: results });
    }
    if (p === "/admin/revoke" && m === "POST") {
      const { email } = await req.json();
      const e = String(email || "").trim().toLowerCase();
      await env.DB.batch([
        env.DB.prepare("UPDATE invites SET revoked=1 WHERE email=?").bind(e),
        env.DB.prepare("DELETE FROM devices WHERE account_id IN (SELECT id FROM accounts WHERE email=?)").bind(e),
      ]);
      return json(200, { ok: true });
    }
    if (p === "/admin/link" && m === "POST") {
      // A magic link for someone without Access (or for an iframe where the Access cookie can't reach).
      const { email, ttlHours } = await req.json();
      if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return err(400, "invalid_email");
      const e = email.trim().toLowerCase();
      const ttl = Math.min(Math.max(Number(ttlHours) || 24, 1), 24 * 14) * 3600;
      const token = randomToken("lnk_");
      await env.DB.prepare("INSERT INTO link_tokens (token_hash,email,expires_at) VALUES (?,?,strftime('%s','now')+?)").bind(await sha256(token), e, ttl).run();
      return json(201, { email: e, url: `${url.origin}/app/#link=${token}`, expiresInHours: ttl / 3600 });
    }
    if (p === "/admin/block" && m === "POST") {
      const { email, blocked = true } = await req.json();
      const e = String(email || "").trim().toLowerCase();
      if (blocked) await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO blocked (email) VALUES (?)").bind(e),
        env.DB.prepare("DELETE FROM devices WHERE account_id IN (SELECT id FROM accounts WHERE email=?)").bind(e),
      ]);
      else await env.DB.prepare("DELETE FROM blocked WHERE email=?").bind(e).run();
      return json(200, { ok: true, email: e, blocked: !!blocked });
    }
    if (p === "/admin/stats" && m === "GET") {
      const r = await env.DB.prepare(
        "SELECT a.email, (SELECT COUNT(*) FROM events e WHERE e.account_id=a.id) AS events, (SELECT COALESCE(SUM(size),0) FROM blobs b WHERE b.account_id=a.id) AS blob_bytes, (SELECT COUNT(*) FROM devices d WHERE d.account_id=a.id) AS devices FROM accounts a",
      ).all();
      return json(200, { accounts: r.results, blobStore: env.BLOBS ? "r2" : "d1" });
    }
    return err(404, "not_found");
  }

  // ---- public
  if (p === "/v1/server") {
    return json(200, { billing: false, market: false, quotaBytes: QUOTA_BYTES, passkeys: { rpId: "" }, sync: { withoutPassword: true }, access: accessOn(env), ai: env.AI_API_KEY ? { model: env.AI_MODEL || "deepseek-flash", effort: env.AI_EFFORT || "high" } : null });
  }
  if (p.startsWith("/v1/telemetry/")) return json(200, { ok: true }); // accepted and dropped
  // ---- AI proxy: the provider key lives only in this worker (secret AI_API_KEY), never in the app or the repo.
  // Model and reasoning effort are fixed here, whatever the client asks for. Per-person daily cap.
  if (p === "/v1/ai/chat/completions" && m === "POST") {
    if (!env.AI_API_KEY) return err(503, "ai_off", "AI grading is not configured on this server.");
    let who = await accessEmail(env, req);
    if (!who && !accessOn(env)) {
      const d = await deviceFor(env, req);
      who = d?.email || null;
    }
    if (!who) return err(401, "unauthorized", "Open Etude through the server's sign-in to use AI grading.");
    if (await env.DB.prepare("SELECT 1 FROM blocked WHERE email=?").bind(who).first()) return err(403, "revoked", "This account is blocked.");
    const day = new Date().toISOString().slice(0, 10);
    const cap = Number(env.AI_DAILY_LIMIT || 300);
    await env.DB.prepare("INSERT INTO ai_usage (email,day,calls) VALUES (?,?,1) ON CONFLICT(email,day) DO UPDATE SET calls=calls+1").bind(who, day).run();
    const used = await env.DB.prepare("SELECT calls FROM ai_usage WHERE email=? AND day=?").bind(who, day).first();
    if (used.calls > cap) return err(429, "ai_daily_limit", `AI grading limit of ${cap} answers per day reached.`);
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) return err(400, "invalid_request");
    // Streaming (the follow-up chat under feedback) is passed through as server-sent events.
    // stream_options is only valid together with stream: true.
    const stream = body.stream === true;
    const upstream = {
      ...body,
      model: env.AI_MODEL || "deepseek-flash",
      reasoning_effort: env.AI_EFFORT || "high",
      thinking: { type: "enabled" },
      stream,
    };
    delete upstream.usage; // OpenRouter-only field
    if (!stream) delete upstream.stream_options;
    const styled = env.AI_STYLE !== "off";
    if (styled) upstream.messages = withHouseStyle(upstream.messages, env.AI_STYLE_EXTRA || "");
    const r = await fetch(env.AI_URL || "https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify(upstream),
    });
    if (stream && r.ok && r.body) {
      const out = styled ? r.body.pipeThrough(dashFilter()) : r.body;
      return new Response(out, { status: 200, headers: { "content-type": r.headers.get("content-type") || "text/event-stream", "cache-control": "no-store" } });
    }
    let text = await r.text();
    if (styled && r.ok) text = undash(text);
    // Pass the provider's answer through; never echo request headers or the key.
    return new Response(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store" } });
  }
  if (p === "/v1/auth/email/start" && m === "POST") return json(200, { ok: true }); // no mail: the invite token is the "code"
  if (p === "/v1/auth/access" && m === "GET") {
    const email = await accessEmail(env, req);
    if (!email) return err(401, "no_access_identity", "Open Etude through Cloudflare Access to sign in automatically.");
    if (await env.DB.prepare("SELECT 1 FROM blocked WHERE email=?").bind(email).first()) return err(403, "revoked", "This account is blocked.");
    const token = randomToken("lnk_");
    await env.DB.prepare("INSERT INTO link_tokens (token_hash,email,expires_at) VALUES (?,?,strftime('%s','now')+60)").bind(await sha256(token), email).run();
    await env.DB.prepare("DELETE FROM link_tokens WHERE expires_at < strftime('%s','now')-86400").run();
    return json(200, { email, token }, { "cache-control": "no-store" });
  }
  if (p === "/v1/auth/email/verify" && m === "POST") {
    const body = await req.json().catch(() => ({}));
    if (!body.token) return err(400, "use_invite_token", "Paste your personal invite token instead of a 6-digit code.");
    const raw = String(body.token).trim();
    let inv;
    if (raw.startsWith("lnk_")) {
      // One-time link token: from /v1/auth/access (Access-verified email) or an admin magic link. Used once, short-lived.
      const h = await sha256(raw);
      inv = await env.DB.prepare("SELECT email FROM link_tokens WHERE token_hash=? AND used=0 AND expires_at > strftime('%s','now')").bind(h).first();
      if (inv) await env.DB.prepare("UPDATE link_tokens SET used=1 WHERE token_hash=?").bind(h).run();
    } else {
      inv = await env.DB.prepare("SELECT email FROM invites WHERE token_hash=? AND revoked=0").bind(await sha256(raw)).first();
    }
    if (!inv) return err(401, "invalid_token", "This sign-in link is not valid or was already used.");
    const revoked = await env.DB.prepare("SELECT 1 FROM blocked WHERE email=?").bind(inv.email).first();
    if (revoked) return err(403, "revoked", "This account is blocked.");
    const a = await accountForEmail(env, inv.email);
    const token = randomToken("etd_");
    await env.DB.prepare("INSERT INTO devices (id,token_hash,account_id,name) VALUES (?,?,?,?)")
      .bind("dev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), await sha256(token), a.id, String(body.deviceName || "Etude").slice(0, 80)).run();
    return json(200, { token, account: { id: a.id, email: a.email } });
  }

  // ---- signed in
  const u = await deviceFor(env, req);
  if (!u) return err(401, "unauthorized", "Sign in again.");
  if (accessOn(env)) {
    // Behind Access, a device token only works for the person Access says is making the request.
    const who = await accessEmail(env, req);
    if (!who || who !== u.email) return err(403, "identity_mismatch", "Signed in to Access as someone else. Sign out of Sync on this device.");
  }
  const acct = u.id;

  if (p === "/v1/auth/logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM devices WHERE id=?").bind(u.device_id).run();
    return json(200, { ok: true });
  }
  if (p === "/v1/me" && m === "GET") return json(200, meOf(u));
  if (p === "/v1/me" && m === "PATCH") {
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare("UPDATE accounts SET display_name=? WHERE id=?").bind(String(b.displayName ?? "").slice(0, 80), acct).run();
    return json(200, meOf({ ...u, display_name: b.displayName }));
  }
  if (p === "/v1/billing/sync") return json(200, { active: true, reason: "self_hosted", source: "manual", status: "active", expires: null, graceUntil: null, billing: false });
  if (p === "/v1/devices" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id,name,created_at,last_seen FROM devices WHERE account_id=? ORDER BY created_at").bind(acct).all();
    return json(200, { devices: results.map((d) => ({ id: d.id, name: d.name || "", via: "invite", created: d.created_at, lastSeen: d.last_seen || d.created_at, current: d.id === u.device_id })) });
  }
  // Features this server does not offer: empty answers in the shapes the app reads.
  if (p === "/v1/me/passkeys" && m === "GET") return json(200, { passkeys: [] });
  if (p === "/v1/me/email/pending" && m === "GET") return json(200, { pending: null });
  if (p === "/v1/library" && m === "GET") return json(200, { items: [], library: [] });
  if (p === "/v1/listings" && m === "GET") return json(200, { listings: [] });
  if (p === "/v1/market/paid-index.json") return json(200, { entries: [] });
  const dev = p.match(/^\/v1\/devices\/([^/]+)$/);
  if (dev && m === "DELETE") {
    await env.DB.prepare("DELETE FROM devices WHERE id=? AND account_id=?").bind(decodeURIComponent(dev[1]), acct).run();
    return json(200, { ok: true });
  }
  if (dev && m === "PATCH") {
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare("UPDATE devices SET name=? WHERE id=? AND account_id=?").bind(String(b.name || "").slice(0, 80), decodeURIComponent(dev[1]), acct).run();
    return json(200, { ok: true });
  }

  // ---- vault
  if (p === "/v1/vault" && m === "GET") {
    const v = await vaultRow(env, acct);
    const keys = v.keys_json ? JSON.parse(v.keys_json) : null;
    const s = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM events WHERE account_id=?1) AS events, (SELECT COUNT(*) FROM blobs WHERE account_id=?1) AS blobs, (SELECT COALESCE(SUM(size),0) FROM blobs WHERE account_id=?1) AS bytes").bind(acct).first();
    return json(200, { hasKeys: !!keys, mode: keys ? (v.server_vk ? "server" : "password") : null, usedBytes: s.bytes, quotaBytes: QUOTA_BYTES, events: s.events, blobs: s.blobs });
  }
  if (p === "/v1/vault/keys") {
    const v = await vaultRow(env, acct);
    const current = `"k${v.keys_etag}"`;
    if (m === "GET") {
      if (!v.keys_json) return err(404, "no_keys");
      const keys = JSON.parse(v.keys_json);
      return json(200, v.server_vk ? { ...keys, server: true } : keys, { etag: current });
    }
    if (m === "PUT") {
      const body = await req.json();
      const ifMatch = req.headers.get("if-match");
      if (v.keys_json && ifMatch !== current) return err(412, "etag_mismatch");
      if (body.server && body.server !== null && typeof body.server === "object") return err(422, "server_slot");
      const { server, ...slots } = body;
      const dropServer = server === null;
      const next = !dropServer && v.server_vk ? { ...slots, server: { kept: true } } : slots;
      const r = await env.DB.prepare("UPDATE vaults SET keys_json=?, keys_etag=keys_etag+1, server_vk=? WHERE account_id=? AND keys_etag=?")
        .bind(JSON.stringify(next), dropServer ? null : v.server_vk, acct, v.keys_etag).run();
      if (!r.meta.changes) return err(412, "etag_mismatch");
      const tag = `"k${v.keys_etag + 1}"`;
      return json(v.keys_json ? 200 : 201, { ok: true, etag: tag }, { etag: tag });
    }
  }
  if (p === "/v1/vault/server-key") {
    const v = await vaultRow(env, acct);
    const current = `"k${v.keys_etag}"`;
    if (m === "GET") return v.server_vk ? json(200, { vk: v.server_vk }) : err(404, "no_server_key");
    if (m === "PUT") {
      const body = await req.json();
      const ifMatch = req.headers.get("if-match");
      if (v.keys_json && ifMatch !== current) return err(v.keys_json && !ifMatch ? 428 : 412, "etag_mismatch");
      const r = await env.DB.prepare("UPDATE vaults SET server_vk=?, keys_json=?, keys_etag=keys_etag+1 WHERE account_id=? AND keys_etag=?")
        .bind(String(body.vk), JSON.stringify({ v: 1, server: { kept: true } }), acct, v.keys_etag).run();
      if (!r.meta.changes) return err(412, "etag_mismatch");
      const tag = `"k${v.keys_etag + 1}"`;
      return json(200, { ok: true, etag: tag }, { etag: tag });
    }
  }
  if (p === "/v1/vault/snapshot") {
    const v = await vaultRow(env, acct);
    const current = `"s${v.snapshot_etag}"`;
    const pointer = v.snapshot_json ? JSON.parse(v.snapshot_json) : null;
    if (m === "GET") return pointer ? json(200, pointer, { etag: current }) : err(404, "no_snapshot");
    if (m === "PUT") {
      const body = await req.json();
      const ifMatch = req.headers.get("if-match");
      if (pointer && ifMatch !== current) return err(412, "etag_mismatch");
      if (!pointer && ifMatch) return err(412, "etag_mismatch");
      if (pointer && body.seq <= pointer.seq) return err(409, "not_newer");
      if (!Array.isArray(body.parts) || !body.parts.every((h) => BLOB_NAME.test(h))) return err(400, "invalid_parts");
      let size = 0;
      for (const h of body.parts) {
        const b = await env.DB.prepare("SELECT size FROM blobs WHERE account_id=? AND name=?").bind(acct, h).first();
        if (!b) return err(422, "missing_part");
        size += b.size;
      }
      const next = { v: 1, id: String(body.id), seq: Number(body.seq), parts: body.parts, size };
      const r = await env.DB.prepare("UPDATE vaults SET snapshot_json=?, snapshot_etag=snapshot_etag+1 WHERE account_id=? AND snapshot_etag=?")
        .bind(JSON.stringify(next), acct, v.snapshot_etag).run();
      if (!r.meta.changes) return err(412, "etag_mismatch");
      const store = blobStore(env);
      for (const h of pointer?.parts ?? []) if (!body.parts.includes(h)) {
        await store.del(acct, h);
        await env.DB.prepare("DELETE FROM blobs WHERE account_id=? AND name=?").bind(acct, h).run();
      }
      const tag = `"s${v.snapshot_etag + 1}"`;
      return json(200, { ok: true, etag: tag }, { etag: tag });
    }
  }

  // ---- events
  if (p === "/v1/sync/events" && m === "POST") {
    const body = await req.json();
    const events = Array.isArray(body.events) ? body.events : [];
    let accepted = 0;
    for (let i = 0; i < events.length; i += 50) {
      const stmts = events.slice(i, i + 50).map((e) =>
        env.DB.prepare("INSERT OR IGNORE INTO events (account_id,id,device,ciphertext) VALUES (?,?,?,?)").bind(acct, String(e.id), u.device_id, String(e.ciphertext)));
      const rs = await env.DB.batch(stmts);
      for (const r of rs) accepted += r.meta.changes;
    }
    const last = await env.DB.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM events WHERE account_id=?").bind(acct).first();
    return json(200, { accepted, duplicates: events.length - accepted, lastSeq: last.s });
  }
  if (p === "/v1/sync/events" && m === "GET") {
    const after = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(url.searchParams.get("limit") || 200) || 200));
    const { results } = await env.DB.prepare("SELECT seq,id,device,ciphertext,at FROM events WHERE account_id=? AND seq>? ORDER BY seq LIMIT ?").bind(acct, after, limit + 1).all();
    const page = [];
    let bytes = 0;
    for (const r of results.slice(0, limit)) {
      if (page.length && bytes + r.ciphertext.length > PAGE_BYTES) break;
      page.push(r);
      bytes += r.ciphertext.length;
    }
    const more = results.length > page.length;
    return json(200, { events: page, cursor: page.at(-1)?.seq ?? after, more });
  }

  // ---- blobs
  const bm = p.match(/^\/v1\/blobs\/([^/]+)$/);
  if (bm) {
    const name = bm[1];
    if (!BLOB_NAME.test(name)) return err(400, "invalid_name");
    const store = blobStore(env);
    if (m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const used = await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS b FROM blobs WHERE account_id=?").bind(acct).first();
      if (used.b + bytes.length > QUOTA_BYTES) return err(413, "quota_exceeded", "Your Sync storage is full.");
      await store.put(acct, name, bytes);
      await env.DB.prepare("INSERT OR REPLACE INTO blobs (account_id,name,size) VALUES (?,?,?)").bind(acct, name, bytes.length).run();
      return json(201, { ok: true, hash: name });
    }
    if (m === "GET") {
      const bytes = await store.get(acct, name);
      if (!bytes) return err(404, "not_found");
      return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" } });
    }
    if (m === "DELETE") {
      const v = await vaultRow(env, acct);
      const pointer = v.snapshot_json ? JSON.parse(v.snapshot_json) : null;
      if (pointer?.parts.includes(name)) return err(409, "in_snapshot");
      const had = await env.DB.prepare("DELETE FROM blobs WHERE account_id=? AND name=?").bind(acct, name).run();
      if (!had.meta.changes) return err(404, "not_found");
      await store.del(acct, name);
      return json(200, { ok: true });
    }
  }

  return err(404, "not_found");
}

// ---------------------------------------------------------------- weekly backup to R2 (when bound)
async function backup(env) {
  if (!env.BACKUPS) return;
  const day = new Date().toISOString().slice(0, 10);
  for (const table of ["accounts", "invites", "devices", "vaults", "events", "blobs"]) {
    let offset = 0;
    const lines = [];
    for (;;) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table} LIMIT 500 OFFSET ?`).bind(offset).all();
      for (const r of results) lines.push(JSON.stringify(r));
      if (results.length < 500) break;
      offset += 500;
    }
    await env.BACKUPS.put(`d1/${day}/${table}.jsonl`, lines.join("\n"));
  }
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    let res;
    try {
      res = await handle(req, env);
    } catch (e) {
      res = err(500, "server_error", String(e?.message || e));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
    return out;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(backup(env));
  },
};
