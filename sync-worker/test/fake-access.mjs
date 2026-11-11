// Test-only stand-in for a Cloudflare Access team domain: serves /cdn-cgi/access/certs and signs
// Access-style JWTs (RS256) on POST /sign {email, aud, exp?, kid?}. A second key ("rogue") is never
// published, to test that forged tokens are rejected.
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";

const PORT = Number(process.env.PORT || 8799);
const ISS = `http://127.0.0.1:${PORT}`;
const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64u = (b) => Buffer.from(b).toString("base64url");

function sign({ email, aud = "test-aud", exp, iss = ISS, kid = "k1", key = "good" }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid, typ: "JWT" };
  const payload = { aud: [aud], iss, iat: now, nbf: now, exp: exp ?? now + 600, type: "app", ...(email ? { email } : {}), sub: "s" + Math.random() };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const s = createSign("RSA-SHA256");
  s.update(input);
  return `${input}.${b64u(s.sign((key === "rogue" ? rogue : good).privateKey))}`;
}

createServer(async (req, res) => {
  if (req.url === "/cdn-cgi/access/certs") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  if (req.url === "/sign" && req.method === "POST") {
    let b = "";
    for await (const c of req) b += c;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jwt: sign(JSON.parse(b || "{}")) }));
  }
  if (req.url === "/fake-ai" && req.method === "POST") {
    let b = "";
    for await (const c of req) b += c;
    const j = JSON.parse(b);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], seen: { model: j.model, reasoning_effort: j.reasoning_effort, auth: req.headers.authorization } }));
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log("fake access on", ISS));
