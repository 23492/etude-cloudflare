// Prints the deploy config for wrangler from environment variables, so no account-specific ids live in the repo.
//   D1_DATABASE_ID   (required) id of the D1 database "etude-sync"
//   CUSTOM_DOMAIN    (optional) e.g. etude.example.com; the zone must be on the same Cloudflare account
//   ALLOWED_ORIGINS  (optional) comma-separated extra origins for CORS (the app itself is same-origin)
//   R2_BLOBS / R2_BACKUPS (optional) bucket names; when set, blobs go to R2 and a weekly D1 export lands in R2
const env = process.env;
if (!env.D1_DATABASE_ID) throw new Error("D1_DATABASE_ID is required");
const cfg = {
  name: "etude-sync",
  main: "src/worker.js",
  compatibility_date: "2026-11-01",
  workers_dev: !env.CUSTOM_DOMAIN,
  assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
  d1_databases: [{ binding: "DB", database_name: "etude-sync", database_id: env.D1_DATABASE_ID }],
  vars: { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || "" },
  triggers: { crons: ["17 3 * * 1"] },
};
if (env.CUSTOM_DOMAIN) cfg.routes = [{ pattern: env.CUSTOM_DOMAIN, custom_domain: true }];
const r2 = [];
if (env.R2_BLOBS) r2.push({ binding: "BLOBS", bucket_name: env.R2_BLOBS });
if (env.R2_BACKUPS) r2.push({ binding: "BACKUPS", bucket_name: env.R2_BACKUPS });
if (r2.length) cfg.r2_buckets = r2;
process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
