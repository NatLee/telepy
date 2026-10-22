/**
 * OpenSSH 公鑰的前端解析：新增金鑰時即時顯示類型、位元數與 SHA256 指紋（和 `ssh-keygen -lf` 一樣）。
 * 只是預覽；真正的檢查（格式、強度、重複）在後端用 russh 做。
 * Client-side OpenSSH public-key parsing for the live preview in the add dialog (type, size and the
 * same SHA256 fingerprint `ssh-keygen -lf` prints). The backend (russh) remains the authority.
 */

export type KeyLabel = "ED25519" | "SK-ED25519" | "ECDSA" | "SK-ECDSA" | "RSA" | "DSA";

export interface ParsedPublicKey {
    algorithm: string;
    label: KeyLabel;
    bits: number | null;
    blob: Uint8Array;
    comment: string;
}

export type KeyProblem = "invalid" | "multiline" | "dsa" | "rsaShort";

const LABELS: [string, KeyLabel][] = [
    ["ssh-ed25519", "ED25519"],
    ["sk-ssh-ed25519@openssh.com", "SK-ED25519"],
    ["sk-ecdsa-sha2-nistp256@openssh.com", "SK-ECDSA"],
    ["ecdsa-sha2-nistp256", "ECDSA"],
    ["ecdsa-sha2-nistp384", "ECDSA"],
    ["ecdsa-sha2-nistp521", "ECDSA"],
    ["ssh-rsa", "RSA"],
    ["ssh-dss", "DSA"],
];

function decodeBase64(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
    try {
        const bin = atob(text);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

/** 讀 SSH wire format 的 string（u32 長度 + 內容）。/ Read one SSH wire-format string. */
function readString(buf: Uint8Array, offset: number): [Uint8Array, number] | null {
    if (offset + 4 > buf.length) return null;
    const len = ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
    const start = offset + 4;
    if (start + len > buf.length) return null;
    return [buf.subarray(start, start + len), start + len];
}

function rsaBits(blob: Uint8Array): number | null {
    // string "ssh-rsa", mpint e, mpint n
    const name = readString(blob, 0);
    const e = name && readString(blob, name[1]);
    const n = e && readString(blob, e[1]);
    if (!n) return null;
    let bytes = n[0];
    while (bytes.length > 0 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length === 0) return 0;
    return (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]));
}

const CURVE_BITS: Record<string, number> = { "ecdsa-sha2-nistp256": 256, "ecdsa-sha2-nistp384": 384, "ecdsa-sha2-nistp521": 521 };

/** 解析一行公鑰；格式不對回 null。/ Parse one public-key line; null when it is not one. */
export function parsePublicKey(text: string): ParsedPublicKey | null {
    const line = text.trim();
    if (!line || line.includes("\n")) return null;
    const [algorithm, b64, ...rest] = line.split(/\s+/);
    const label = LABELS.find(([name]) => name === algorithm)?.[1];
    const blob = b64 ? decodeBase64(b64) : null;
    if (!label || !blob) return null;
    // blob 裡的第一個欄位必須和宣告的類型一致。/ The blob must start with the declared algorithm.
    const inner = readString(blob, 0);
    if (!inner || new TextDecoder().decode(inner[0]) !== algorithm) return null;
    const bits = label === "RSA" ? rsaBits(blob) : label === "ED25519" || label === "SK-ED25519" ? 256 : CURVE_BITS[algorithm] ?? (label === "SK-ECDSA" ? 256 : null);
    return { algorithm, label, bits, blob, comment: rest.join(" ") };
}

/** 與後端相同的強度規則（後端會再擋一次）。/ Same strength rules as the backend. */
export function keyProblem(text: string): KeyProblem | null {
    if (text.trim().includes("\n")) return "multiline";
    const k = parsePublicKey(text);
    if (!k) return "invalid";
    if (k.label === "DSA") return "dsa";
    if (k.label === "RSA" && (k.bits ?? 0) < 2048) return "rsaShort";
    return null;
}

/** `SHA256:…`（無 padding 的 base64，與 ssh-keygen 相同）。/ OpenSSH-style SHA256 fingerprint. */
export async function fingerprint(key: ParsedPublicKey): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", key.blob as BufferSource));
    let bin = "";
    digest.forEach((b) => (bin += String.fromCharCode(b)));
    return `SHA256:${btoa(bin).replace(/=+$/, "")}`;
}

/** 指紋太長時的短版：`SHA256:abcd…wxyz`。/ Shortened fingerprint for tight spots. */
export function shortFingerprint(fp: string | null | undefined): string {
    if (!fp) return "—";
    const body = fp.replace(/^SHA256:/, "");
    return body.length > 14 ? `SHA256:${body.slice(0, 6)}…${body.slice(-6)}` : fp;
}
