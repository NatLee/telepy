/**
 * 建立通道精靈的純函式：公鑰解析、把金鑰加進 authorized_keys 的指令、一次性腳本指令、登入檢查錯誤分類。
 * Pure helpers for the create-tunnel wizard: public-key parsing, the "append to authorized_keys" command,
 * one-time script commands and login-check error classification.
 */

export type KeyAlgo = "ED25519" | "RSA" | "ECDSA" | "DSA";

const ALGOS: Record<string, KeyAlgo> = {
    "ssh-ed25519": "ED25519",
    "ssh-rsa": "RSA",
    "ecdsa-sha2-nistp256": "ECDSA",
    "ecdsa-sha2-nistp384": "ECDSA",
    "ecdsa-sha2-nistp521": "ECDSA",
    "ssh-dss": "DSA",
};

export type KeyCheck =
    | { kind: "empty" }
    | { kind: "private" }
    | { kind: "invalid" }
    | { kind: "valid"; algo: KeyAlgo; comment: string; tail: string; normalized: string };

/**
 * 貼上的內容常帶換行或被終端機折行：去頭尾空白、把內部空白壓成一格。
 * Pasted keys often carry newlines or terminal wrapping: trim and collapse inner whitespace.
 */
export function normalizePublicKey(raw: string): string {
    return raw.trim().split(/\s+/).join(" ");
}

/**
 * 去掉註解的公鑰（`<type> <base64>`）：比對兩把是不是同一把，跟後端一樣不看註解。
 * The key without its comment (`<type> <base64>`), to tell whether two lines are the same key — comments ignored, like the backend.
 */
export function bareKey(raw: string): string {
    return normalizePublicKey(raw).split(" ").slice(0, 2).join(" ");
}

/** 解析使用者貼上的公鑰；私鑰要特別警告。/ Parse a pasted public key; private keys get a dedicated warning. */
export function checkPublicKey(raw: string): KeyCheck {
    const text = raw.trim();
    if (!text) return { kind: "empty" };
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return { kind: "private" };
    const normalized = normalizePublicKey(text);
    const [type, body, ...rest] = normalized.split(" ");
    const algo = ALGOS[type];
    if (!algo || !body || !/^[A-Za-z0-9+/]+={0,3}$/.test(body) || body.length < 16) return { kind: "invalid" };
    return { kind: "valid", algo, comment: rest.join(" "), tail: body.slice(-10), normalized };
}

/** 公鑰註解的「user」部分（natlee@macbook → natlee），拿來建議登入帳號。/ The user part of a key comment, used to suggest an account. */
export function commentUser(comment: string): string | null {
    const user = comment.split("@")[0]?.trim();
    return user && /^[a-z_][a-z0-9._-]{0,31}$/i.test(user) ? user : null;
}

/**
 * 名稱規則與後端相同：第一個字必須是字母（Rust `is_alphabetic`，含中日文）。
 * Same rule as the backend: the name must start with a letter (Rust `is_alphabetic`, CJK included).
 */
export function isValidTunnelName(name: string): boolean {
    return /^\p{Alphabetic}/u.test(name.trim());
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type DeviceOs = "unix" | "windows";

/**
 * 把金鑰「附加」到目前帳號的 authorized_keys：已存在的金鑰保留、重跑不會重複；
 * 檔案結尾沒有換行時先補一個，避免新金鑰黏在最後一行後面。
 * Append keys to the current account's authorized_keys: existing keys are kept, re-running adds nothing twice,
 * and a missing trailing newline is fixed first so the new key never glues onto the last line.
 */
export function authorizeKeysCommand(keys: string[], os: DeviceOs): string {
    if (keys.length === 0) return "";
    if (os === "windows") {
        return [
            `$f = "$env:USERPROFILE\\.ssh\\authorized_keys"`,
            `New-Item -ItemType Directory -Force -Path (Split-Path $f) | Out-Null`,
            `if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f | Out-Null }`,
            `$raw = [IO.File]::ReadAllText($f); if ($raw.Length -gt 0 -and -not $raw.EndsWith("\`n")) { Add-Content -Path $f -Value '' }`,
            `foreach ($k in @(`,
            keys.map((k) => `    ${psQuote(k)}`).join(",\n"),
            `)) { if (-not (Select-String -Path $f -SimpleMatch -Quiet -Pattern $k)) { Add-Content -Path $f -Value $k } }`,
        ].join("\n");
    }
    return [
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
        `[ -n "$(tail -c1 ~/.ssh/authorized_keys)" ] && echo >> ~/.ssh/authorized_keys`,
        `for k in \\`,
        keys.map((k) => `  ${shQuote(k)}`).join(" \\\n") + `; do`,
        `  grep -qxF "$k" ~/.ssh/authorized_keys || echo "$k" >> ~/.ssh/authorized_keys`,
        `done`,
    ].join("\n");
}

export type ConnectMethod = "ssh" | "autossh" | "autossh-service" | "docker-run" | "docker-compose" | "powershell";

/** 一次性網址 → 在裝置上貼上就能跑的指令（與 ServerScriptModal 相同）。/ One-time URL → paste-ready command (same as ServerScriptModal). */
export function oneTimeCommand(method: ConnectMethod, url: string): string {
    if (method === "docker-compose") {
        return `curl -fsSL '${url}' -o telepy-docker-compose.yml && docker compose -f telepy-docker-compose.yml up -d`;
    }
    if (method === "powershell") {
        return `powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing '${url}' -OutFile 'telepy-tunnel.ps1'; & '.\\telepy-tunnel.ps1'"`;
    }
    return `curl -fsSL '${url}' | bash`;
}

export const METHOD_LANGUAGE: Record<ConnectMethod, string> = {
    ssh: "bash",
    autossh: "bash",
    "autossh-service": "bash",
    "docker-run": "bash",
    "docker-compose": "yaml",
    powershell: "powershell",
};

export type LoginFailure = "auth" | "offline" | "other";

/**
 * `/api/sftp/shell` 的錯誤訊息是 anyhow 最外層 context：認證失敗是 "device auth"，
 * 連不到裝置是 "connect to 127.0.0.1:<port>" 或逾時。
 * The /api/sftp/shell error is anyhow's outer context: "device auth" when the key is refused,
 * "connect to 127.0.0.1:<port>" or a timeout when the tunnel is down.
 */
export function classifyLoginError(message: string): LoginFailure {
    const m = message.toLowerCase();
    if (m.includes("device auth")) return "auth";
    if (m.includes("connect to") || m.includes("timed out")) return "offline";
    return "other";
}
