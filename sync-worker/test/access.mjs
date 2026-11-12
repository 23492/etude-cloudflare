// Access mode: automatic sign-in from a verified Access JWT, and isolation between people.
// Usage: node test/access.mjs <worker-url> <fake-access-url>
import assert from "node:assert/strict";
const [S, A] = process.argv.slice(2);
const ADMIN = process.env.ADMIN || "local-admin";
const jwtFor = async (o) => (await (await fetch(A + "/sign", { method: "POST", body: JSON.stringify(o) })).json()).jwt;
const call = async (method, path, { jwt, token, body } = {}) => {
  const h = {};
  if (jwt) h["cf-access-jwt-assertion"] = jwt;
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(S + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: r.headers.get("content-type")?.includes("json") ? await r.json() : null };
};
const signInAs = async (email) => {
  const jwt = await jwtFor({ email });
  const a = await call("GET", "/v1/auth/access", { jwt });
  assert.equal(a.status, 200, "access token for " + email);
  const v = await call("POST", "/v1/auth/email/verify", { jwt, body: { token: a.data.token, deviceName: "t" } });
  assert.equal(v.status, 200);
  return { jwt, token: v.data.token, link: a.data.token };
};

assert.equal((await call("GET", "/v1/server")).data.access, true, "server reports access mode");

// No / bad identity -> no token
assert.equal((await call("GET", "/v1/auth/access")).status, 401, "no JWT");
assert.equal((await call("GET", "/v1/auth/access", { jwt: "x.y.z" })).status, 401, "garbage JWT");
assert.equal((await call("GET", "/v1/auth/access", { jwt: await jwtFor({ email: "a@x.test", key: "rogue" }) })).status, 401, "forged signature");
assert.equal((await call("GET", "/v1/auth/access", { jwt: await jwtFor({ email: "a@x.test", aud: "other-app" }) })).status, 401, "wrong audience");
assert.equal((await call("GET", "/v1/auth/access", { jwt: await jwtFor({ email: "a@x.test", exp: 1000 }) })).status, 401, "expired");
assert.equal((await call("GET", "/v1/auth/access", { jwt: await jwtFor({ email: "a@x.test", iss: "https://evil.example" }) })).status, 401, "wrong issuer");
assert.equal((await call("GET", "/v1/auth/access", { jwt: await jwtFor({}) })).status, 401, "service token (no email)");

// Automatic sign-in; account is created from the verified email
const alice = await signInAs("Alice@X.test");
assert.equal((await call("GET", "/v1/me", { jwt: alice.jwt, token: alice.token })).data.email, "alice@x.test");
// Link tokens are one-time
assert.equal((await call("POST", "/v1/auth/email/verify", { body: { token: alice.link } })).status, 401, "link token reuse");

// Isolation: Alice's device token is useless under Bob's Access identity, and without any identity
const bob = await signInAs("bob@x.test");
await call("POST", "/v1/sync/events", { jwt: alice.jwt, token: alice.token, body: { events: [{ id: "a1", ciphertext: "secret-a" }] } });
assert.equal((await call("GET", "/v1/sync/events?after=0", { jwt: bob.jwt, token: alice.token })).status, 403, "alice token + bob identity");
assert.equal((await call("GET", "/v1/sync/events?after=0", { token: alice.token })).status, 403, "token without Access identity");
assert.equal((await call("GET", "/v1/sync/events?after=0", { jwt: bob.jwt, token: bob.token })).data.events.length, 0, "bob sees none of alice's events");
assert.equal((await call("GET", "/v1/sync/events?after=0", { jwt: alice.jwt, token: alice.token })).data.events.length, 1);

// Admin magic link (for people/iframes without the Access cookie): one-time, maps to that email only
const ml = await (await fetch(S + "/admin/link", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ email: "carol@x.test", ttlHours: 1 }) })).json();
assert.match(ml.url, /\/app\/#link=lnk_[a-f0-9]+$/);
const carolLink = ml.url.split("#link=")[1];
const cv = await call("POST", "/v1/auth/email/verify", { body: { token: carolLink } });
assert.equal(cv.status, 200);
assert.equal(cv.data.account.email, "carol@x.test");

// Blocking cuts off every route
await fetch(S + "/admin/block", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ email: "bob@x.test" }) });
assert.equal((await call("GET", "/v1/me", { jwt: bob.jwt, token: bob.token })).status, 401, "blocked: devices removed");
assert.equal((await call("GET", "/v1/auth/access", { jwt: bob.jwt })).status, 403, "blocked: no new sign-in");

// AI proxy: requires an Access identity, forces model + effort, never needs a client key
{
  const ai = (await call("GET", "/v1/server")).data.ai;
  assert.deepEqual(ai, { model: "deepseek-flash", effort: "high" }, "server advertises AI");
  assert.equal((await call("POST", "/v1/ai/chat/completions", { body: { messages: [{ role: "user", content: "hi" }] } })).status, 401, "AI without identity");
  const alice2 = await jwtFor({ email: "alice@x.test" });
  const r = await call("POST", "/v1/ai/chat/completions", { jwt: alice2, body: { model: "gpt-expensive", messages: [{ role: "user", content: "hi" }] } });
  assert.equal(r.status, 200, "AI proxy answers");
  assert.equal(r.data.seen.model, "deepseek-flash", "model forced");
  assert.equal(r.data.seen.reasoning_effort, "high", "effort forced");
  assert.equal(r.data.seen.auth, "Bearer test-ai-key", "key added server-side");
  // House style: appended to the app's system prompt (or added as one), and dashes removed from the answer.
  assert.match(r.data.seen.system, /House style/, "house style added when there is no system prompt");
  assert.equal(r.data.seen.n, 2, "one system message added");
  assert.equal(r.data.choices[0].message.content, "ok, fine, 3-5", "dashes removed from the answer");
  const sp = await call("POST", "/v1/ai/chat/completions", { jwt: alice2, body: { messages: [{ role: "system", content: "You are Minimi." }, { role: "user", content: "hi" }] } });
  assert.match(sp.data.seen.system, /^You are Minimi\.\n\nHouse style/, "house style appended after the app's own prompt");
  // Grading/feedback request as Etude sends it (OpenRouter-style usage field, no stream).
  const g = await call("POST", "/v1/ai/chat/completions", { jwt: alice2, body: { messages: [{ role: "user", content: "hi" }], usage: { include: true } } });
  assert.equal(g.status, 200, "non-stream request with usage field");
  // Follow-up chat: stream + stream_options, passed through as server-sent events.
  const s = await fetch(S + "/v1/ai/chat/completions", { method: "POST", headers: { "cf-access-jwt-assertion": alice2, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } }) });
  assert.equal(s.status, 200, "streaming request accepted");
  assert.match(s.headers.get("content-type") || "", /event-stream/, "streamed back as SSE");
  const st = await s.text();
  assert.match(st, /"deepseek-flash"/, "model forced when streaming");
  assert.match(st, /House style/, "house style added when streaming");
  assert.doesNotMatch(st, /\\u2014|\u2014/, "no em dash left in the stream");
  assert.match(st, /\[DONE\]/, "stream complete");
  // A stray stream_options without stream is dropped instead of failing upstream.
  const so = await call("POST", "/v1/ai/chat/completions", { jwt: alice2, body: { messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } } });
  assert.equal(so.status, 200, "stream_options without stream");
}
console.log("access: all checks passed");
