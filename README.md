# etude-hosting

Self-host [Etude](https://github.com/Zibhelina/etude) for yourself and your friends on Cloudflare's free plan: the browser edition of the app plus your own Sync server, both on one Cloudflare Worker.

- **App:** Etude's browser edition, served from `/app/` as Workers Static Assets. It works offline and installs as a PWA. Each person's collection lives in their own browser.
- **Sync:** `sync-worker/` implements the subset of the etude-cloud `/v1` protocol that Etude's sync client uses, so every person's collection syncs across their devices. Data is stored in Cloudflare D1, and optionally in R2.
- **No email service needed:** the admin creates a personal invite token per person. In Etude you open Settings → Sync, enter your email and paste the invite token where the app asks for the code.

This project is not affiliated with Etude. The protocol is reconstructed from Etude's open client code and from the fake servers in its tests. A future Etude release may change the protocol, so CI pins an Etude commit and runs Etude's own cloud sync property test (3 devices, 240 rounds) against this worker before you bump it.

## Layout

| Path | What |
|---|---|
| `sync-worker/src/worker.js` | The worker: static app plus `/v1` Sync API plus `/admin` invite API |
| `sync-worker/schema.sql` | D1 schema |
| `scripts/render-wrangler.mjs` | Writes the deploy config from secrets, so no account ids live in the repo |
| `etude.ref` | The Etude release that is tested and deployed |
| `sync-worker/test/smoke.mjs` | Protocol smoke test against a running worker |
| `sync-worker/test/outbox-proxy.mjs` | Test-only proxy that lets Etude's own sync test sign in |
| `scripts/patch-etude.sh` | Points an Etude checkout at your Sync URL instead of sync.etude.study |
| `.github/workflows/ci.yml` | Builds the app, runs the smoke test and Etude's sync property test |

## Staying up to date with Etude

A daily workflow checks Etude's latest release. When there is a new one, CI builds it and runs Etude's own cloud sync property test against this worker. If that passes, the bot commits the new tag to `etude.ref` and deploys it. If it fails, the deployed version stays as it is and an issue is opened, so a protocol change in Etude never breaks your Sync.

## Deploy

Repository settings → Secrets and variables → Actions:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | Token with Workers Scripts edit, D1 edit and (for a custom domain) Workers Routes / DNS edit |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Your account id |
| `D1_DATABASE_ID` | secret | `wrangler d1 create etude-sync` |
| `SYNC_URL` | variable | `https://etude.your-domain.tld` |
| `CUSTOM_DOMAIN` | variable | `etude.your-domain.tld` (optional; without it the worker runs on workers.dev) |

Without the secrets, CI still builds and tests but skips the deploy. Then set the admin secret once: `wrangler secret put ADMIN_TOKEN --name etude-sync`, and create an invite per person:

```sh
curl -X POST https://etude.your-domain.tld/admin/invites \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"email":"friend@example.com"}'
```

## Cloudflare Access (optional, recommended)

Put a self-hosted Access application in front of your domain and set two repository variables:

| Name | Value |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `https://<your-team>.cloudflareaccess.com` |
| `ACCESS_AUD` | the application's audience tag (Access → Applications → your app → Additional settings) |

With both set, people sign in once through Access and the app links itself to Sync without a code: the bundled `autolink.js` asks `/v1/auth/access` for a one-time token, the worker issues it only after verifying the Access JWT (RS256 signature against your team's certs, audience, issuer and expiry), and creates the account for that email if needed. Behind Access every device token only works for the person Access says is making the request. Who may use the app is managed entirely in Access policies.

Admin endpoints: `POST /admin/link` (one-time `#link=` magic link for an email), `POST /admin/block` (block an email and drop its devices), `GET /admin/stats`.

## AI grading proxy (optional)

Set the worker secret `AI_API_KEY` outside the repo (`wrangler secret put AI_API_KEY`, or the dashboard as type *Secret*). The app is then configured automatically to grade through `/v1/ai/chat/completions`; the worker adds the key, forces `AI_MODEL` (default `deepseek-flash`) and `AI_EFFORT` (default `high`), and caps each person at `AI_DAILY_LIMIT` answers per day (default 300). The key never reaches the browser or CI.

## Security notes

- Device and invite tokens are stored only as SHA-256 hashes.
- Every sync payload is encrypted by the Etude client before upload. Without a Sync password the server keeps the vault key (`withoutPassword: true`), so the operator could in principle decrypt it. Set a Sync password in Etude for end-to-end encryption.
- `/admin/*` requires the `ADMIN_TOKEN` secret (`wrangler secret put ADMIN_TOKEN`).

## License

AGPL-3.0, the same license as Etude.
