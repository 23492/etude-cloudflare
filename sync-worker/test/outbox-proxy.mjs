// Test-only proxy in front of `wrangler dev`, so Etude's own cloud sync property test
// (test/sync.test.ts, ETUDE_SYNC_TEST_SERVER + ETUDE_SYNC_TEST_OUTBOX) can sign in.
// On POST /v1/auth/email/start it creates an invite via the admin API and writes it to the
// outbox folder as {to, meta:{token}}, which is the format the test's login() helper reads.
// Everything else is forwarded unchanged.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UPSTREAM = process.env.UPSTREAM || "http://127.0.0.1:8787";
const OUTBOX = process.env.OUTBOX || "/tmp/etude-outbox";
const ADMIN = process.env.ADMIN_TOKEN || "local-admin";
const PORT = Number(process.env.PORT || 8788);
mkdirSync(OUTBOX, { recursive: true });
let n = 0;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  try {
    if (req.method === "POST" && req.url === "/v1/auth/email/start") {
      const { email } = JSON.parse(body.toString() || "{}");
      const r = await fetch(`${UPSTREAM}/admin/invites`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ email }) });
      const inv = await r.json();
      writeFileSync(join(OUTBOX, `${Date.now()}-${n++}.json`), JSON.stringify({ to: email, meta: { token: inv.token } }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    const r = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const out = Buffer.from(await r.arrayBuffer());
    const h = Object.fromEntries(r.headers);
    delete h["content-encoding"];
    delete h["content-length"];
    delete h["transfer-encoding"];
    res.writeHead(r.status, h);
    res.end(out);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "proxy", message: String(e) } }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`outbox proxy on :${PORT} -> ${UPSTREAM}, outbox ${OUTBOX}`));
