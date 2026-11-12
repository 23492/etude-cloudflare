// Prints the deploy config for wrangler from environment variables, so no account-specific ids live in the repo.
//   D1_DATABASE_ID   (required) id of the D1 database
//   D1_DATABASE_NAME (optional) its name, default "etude-sync"
//   CUSTOM_DOMAIN    (optional) e.g. etude.example.com; the zone must be on the same Cloudflare account
//   ACCESS_TEAM_DOMAIN, ACCESS_AUD (optional) Cloudflare Access team URL and application audience tag
//   WORKERS_DEV      (optional) "true" keeps the workers.dev URL on; off by default when a custom domain is set
//   ALLOWED_ORIGINS  (optional) comma-separated extra origins for CORS (the app itself is same-origin)
//   AI_STYLE (optional) "off" drops the house style the AI proxy adds; AI_STYLE_EXTRA adds your own lines
//   PLANNER (optional) "off" disables the certification planner; PLANNER_TZ its time zone (default Europe/Amsterdam)
//   R2_BLOBS / R2_BACKUPS (optional) bucket names; when set, blobs go to R2 and a weekly D1 export lands in R2
const env = process.env;
if (!env.D1_DATABASE_ID) throw new Error("D1_DATABASE_ID is required");
const cfg = {
  name: "etude-sync",
  main: "src/worker.js",
  compatibility_date: "2026-11-01",
  workers_dev: env.WORKERS_DEV === "true" || !env.CUSTOM_DOMAIN,
  assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
  d1_databases: [{ binding: "DB", database_name: env.D1_DATABASE_NAME || "etude-sync", database_id: env.D1_DATABASE_ID }],
  vars: {
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || "",
    // Cloudflare Access: when both are set, sign-in is automatic and every /v1 call must match the Access identity.
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN || "",
    ACCESS_AUD: env.ACCESS_AUD || "",
    // AI proxy settings (the key itself is a Worker secret, AI_API_KEY, set outside the repo and CI).
    AI_MODEL: env.AI_MODEL || "deepseek-flash",
    AI_EFFORT: env.AI_EFFORT || "high",
    AI_DAILY_LIMIT: env.AI_DAILY_LIMIT || "300",
    // House style added to every AI answer (short, answer first, jargon kept literal, no dashes). "off" disables it.
    AI_STYLE: env.AI_STYLE || "on",
    AI_STYLE_EXTRA: env.AI_STYLE_EXTRA || "",
    // Certification planner (practice questions released after their concepts, misses followed up). "off" disables it.
    PLANNER: env.PLANNER || "on",
    PLANNER_TZ: env.PLANNER_TZ || "Europe/Amsterdam",
  },
  triggers: { crons: ["17 3 * * 1", "*/10 * * * *"] }, // weekly backup; certification planner
};
if (env.CUSTOM_DOMAIN) cfg.routes = [{ pattern: env.CUSTOM_DOMAIN, custom_domain: true }];
const r2 = [];
if (env.R2_BLOBS) r2.push({ binding: "BLOBS", bucket_name: env.R2_BLOBS });
if (env.R2_BACKUPS) r2.push({ binding: "BACKUPS", bucket_name: env.R2_BACKUPS });
if (r2.length) cfg.r2_buckets = r2;
process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
