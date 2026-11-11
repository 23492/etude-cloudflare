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
| `sync-worker/wrangler.jsonc` | Deploy config (fill in your D1 id) |
| `sync-worker/test/smoke.mjs` | Protocol smoke test against a running worker |
| `sync-worker/test/outbox-proxy.mjs` | Test-only proxy that lets Etude's own sync test sign in |
| `scripts/patch-etude.sh` | Points an Etude checkout at your Sync URL instead of sync.etude.study |
| `.github/workflows/ci.yml` | Builds the app, runs the smoke test and Etude's sync property test |

## Status

Work in progress: the worker and CI exist; deployment docs follow once CI is green.

## Security notes

- Device and invite tokens are stored only as SHA-256 hashes.
- Every sync payload is encrypted by the Etude client before upload. Without a Sync password the server keeps the vault key (`withoutPassword: true`), so the operator could in principle decrypt it. Set a Sync password in Etude for end-to-end encryption.
- `/admin/*` requires the `ADMIN_TOKEN` secret (`wrangler secret put ADMIN_TOKEN`).

## License

AGPL-3.0, the same license as Etude.
