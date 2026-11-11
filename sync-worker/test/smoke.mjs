// Protocol smoke test against a running worker (wrangler dev). Usage: node test/smoke.mjs http://127.0.0.1:8787
import assert from "node:assert/strict";
const S = process.argv[2] || "http://127.0.0.1:8787";
const call = async (method, path, { token, body, headers = {}, raw } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h["content-type"] = "application/json";
  const r = await fetch(S + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = r.headers.get("content-type")?.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer());
  return { status: r.status, etag: r.headers.get("etag"), data: text };
};

assert.equal((await call("GET", "/v1/server")).data.sync.withoutPassword, true);
assert.equal((await call("GET", "/v1/me")).status, 401);
assert.equal((await call("POST", "/admin/invites", { body: { email: "a@x.test" } })).status, 401);
const inv = (await call("POST", "/admin/invites", { token: process.env.ADMIN || "local-admin", body: { email: "Smoke@X.test" } })).data;
assert.match(inv.token, /^inv_/);
assert.equal((await call("POST", "/v1/auth/email/verify", { body: { email: "smoke@x.test", code: "123456" } })).status, 400);
assert.equal((await call("POST", "/v1/auth/email/verify", { body: { token: "inv_nope" } })).status, 401);
const v = (await call("POST", "/v1/auth/email/verify", { body: { token: inv.token, deviceName: "smoke" } })).data;
const t = v.token;
assert.equal(v.account.email, "smoke@x.test");
const me = (await call("GET", "/v1/me", { token: t })).data;
assert.equal(me.sync.active, true);
assert.equal((await call("GET", "/v1/vault", { token: t })).data.hasKeys, false);
assert.equal((await call("GET", "/v1/vault/keys", { token: t })).status, 404);
// keys with etag
const k1 = await call("PUT", "/v1/vault/keys", { token: t, body: { v: 1, password: { x: 1 } } });
assert.equal(k1.status, 201);
assert.equal((await call("PUT", "/v1/vault/keys", { token: t, body: { v: 1 } })).status, 412);
assert.equal((await call("PUT", "/v1/vault/keys", { token: t, body: { v: 1, password: { x: 2 } }, headers: { "if-match": k1.etag } })).status, 200);
// events
const evs = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, ciphertext: "c".repeat(100) + i }));
const pushed = (await call("POST", "/v1/sync/events", { token: t, body: { events: evs } })).data;
assert.equal(pushed.accepted, 120);
assert.equal((await call("POST", "/v1/sync/events", { token: t, body: { events: evs.slice(0, 5) } })).data.duplicates, 5);
let cursor = 0, got = 0, more = true;
while (more) { const p = (await call("GET", `/v1/sync/events?after=${cursor}&limit=50`, { token: t })).data; got += p.events.length; cursor = p.cursor; more = p.more; }
assert.equal(got, 120);
// blobs (1.5 MiB to cross a chunk boundary in the D1 fallback)
const big = new Uint8Array(1.5 * 1024 * 1024).map((_, i) => i % 251);
const name = "a".repeat(64);
assert.equal((await call("PUT", `/v1/blobs/${name}`, { token: t, raw: big })).status, 201);
const back = (await call("GET", `/v1/blobs/${name}`, { token: t })).data;
assert.equal(back.length, big.length);
assert.ok(back.every((b, i) => b === big[i]));
// snapshot
assert.equal((await call("PUT", "/v1/vault/snapshot", { token: t, body: { id: "s1", seq: 10, parts: ["b".repeat(64)] } })).status, 422);
const s1 = await call("PUT", "/v1/vault/snapshot", { token: t, body: { id: "s1", seq: 10, parts: [name] } });
assert.equal(s1.status, 200);
assert.equal((await call("DELETE", `/v1/blobs/${name}`, { token: t })).status, 409);
assert.equal((await call("GET", "/v1/vault/snapshot", { token: t })).data.size, big.length);
// another account sees nothing
const inv2 = (await call("POST", "/admin/invites", { token: process.env.ADMIN || "local-admin", body: { email: "other@x.test" } })).data;
const t2 = (await call("POST", "/v1/auth/email/verify", { body: { token: inv2.token } })).data.token;
assert.equal((await call("GET", "/v1/sync/events?after=0", { token: t2 })).data.events.length, 0);
assert.equal((await call("GET", `/v1/blobs/${name}`, { token: t2 })).status, 404);
// logout revokes the device
await call("POST", "/v1/auth/logout", { token: t2, body: {} });
assert.equal((await call("GET", "/v1/me", { token: t2 })).status, 401);
console.log("smoke: all checks passed");
// shapes the app's Settings screens read
{
  const inv3 = (await call("POST", "/admin/invites", { token: process.env.ADMIN || "local-admin", body: { email: "shape@x.test" } })).data;
  const t3 = (await call("POST", "/v1/auth/email/verify", { body: { token: inv3.token } })).data.token;
  const d = (await call("GET", "/v1/devices", { token: t3 })).data;
  assert.ok(Array.isArray(d.devices) && d.devices.length === 1 && d.devices[0].current === true, "devices is {devices:[...]}");
  assert.deepEqual((await call("GET", "/v1/me/passkeys", { token: t3 })).data, { passkeys: [] });
  console.log("smoke: shapes ok");
}
