/**
 * Sync env from repo root .env to frontend .env.local.
 * Maps: SOCIAL_GOOGLE_CLIENT_ID -> NEXT_PUBLIC_GOOGLE_CLIENT_ID,
 *       SERVER_DOMAIN + WEB_SERVER_PORT -> NEXT_PUBLIC_API_BASE, NEXT_PUBLIC_WS_HOST.
 * Run from repo root or frontend dir: node src/frontend/scripts/sync-env.js (or npm run env:sync from frontend).
 */

const fs = require("fs");
const path = require("path");

const frontendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendDir, "../..");
const rootEnvPath = path.join(repoRoot, ".env");
const localEnvPath = path.join(frontendDir, ".env.local");

function parseEnv(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

let rootEnv = {};
if (fs.existsSync(rootEnvPath)) {
  rootEnv = parseEnv(fs.readFileSync(rootEnvPath, "utf8"));
}

const domain = rootEnv.SERVER_DOMAIN || "localhost";
const port = rootEnv.WEB_SERVER_PORT || "8787";
const apiBase = `http://${domain}:${port}`;
const wsHost = `${domain}:${port}`;

const out = [
  "# Auto-generated from repo root .env by scripts/sync-env.js. Do not edit manually if you run env:sync.",
  `NEXT_PUBLIC_API_BASE=${apiBase}`,
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID=${rootEnv.SOCIAL_GOOGLE_CLIENT_ID ?? ""}`,
  "# In dev, WebSockets must connect directly to backend (Next.js rewrites don't proxy WS)",
  `NEXT_PUBLIC_WS_HOST=${wsHost}`,
  "",
].join("\n");

fs.writeFileSync(localEnvPath, out, "utf8");
console.log("Synced root .env ->", localEnvPath);
