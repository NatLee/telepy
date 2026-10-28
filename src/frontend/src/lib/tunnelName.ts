/**
 * 隧道名稱的規則（後端 `src/backend-api/src/tunnel_name.rs` 的同一份，`tunnelName.test.ts` 會讀 Rust 檔比對）：名稱會變成 ssh 的
 * 主機名稱（產生的 ssh config 是 `HostName <名稱>`），所以照 OpenSSH 的規矩——空白在 ssh_config 裡分隔好幾個別名、在命令列
 * 會被 OpenSSH 9.6 起直接拒絕；`* ? ! ,` 是樣式符號、`%` 會被當成 `%h` 展開、`#` 是註解；`@` `:` 是 Telepy 自己的
 * `<隧道>@<帳號>`、`<隧道>:<路徑>`。所以只收英數與 `. _ -`，字母或數字開頭，最多 63 字。ssh 連線時主機名稱一律轉成
 * 小寫，所以只差大小寫的名稱算同一個。
 * Tunnel name rules (the same as the backend's `tunnel_name.rs`; the test reads the Rust file): the name becomes an
 * ssh host name, so it follows OpenSSH — ASCII letters, digits, `.`, `_`, `-`, starting with a letter or digit, at
 * most 63 characters, and unique ignoring case because ssh lowercases host names when it connects.
 */
import type { TranslationKey } from "../locales/en.ts";

export const TUNNEL_NAME_MAX = 63;

export type TunnelNameProblem = "name_empty" | "name_too_long" | "name_first_char" | "name_chars";

export const NAME_PROBLEM_KEY: Record<TunnelNameProblem, TranslationKey> = {
    name_empty: "tunnelName.err.empty",
    name_too_long: "tunnelName.err.tooLong",
    name_first_char: "tunnelName.err.firstChar",
    name_chars: "tunnelName.err.chars",
};

const allowed = (c: string) => /^[A-Za-z0-9._-]$/.test(c);
const alnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

/** 名稱哪裡不行；`null` = 可以用。順序同後端：先看字元、再看開頭、最後長度。/ What is wrong; `null` = fine. */
export function tunnelNameProblem(name: string): TunnelNameProblem | null {
    const chars = Array.from(name);
    if (chars.length === 0) return "name_empty";
    if (!chars.every(allowed)) return "name_chars";
    if (!alnum(chars[0])) return "name_first_char";
    if (name.length > TUNNEL_NAME_MAX) return "name_too_long";
    return null;
}

/** 能不能直接當 ssh 的主機名稱。/ Whether the name can be an ssh host name as is. */
export function sshSafeName(name: string): boolean {
    return tunnelNameProblem(name) === null;
}

/**
 * 名稱裡不能用的字（不重複，照出現順序），給錯誤訊息列出來；空白顯示成「空白」由呼叫的人處理。
 * The characters that are not allowed (distinct, in order) for the error message.
 */
export function badChars(name: string): string[] {
    const out: string[] = [];
    for (const c of Array.from(name)) if (!allowed(c) && !out.includes(c)) out.push(c);
    return out;
}

/**
 * 改成合規的名稱（同後端 `tunnel_name::suggest`）：不合的字（連續的算一個）換成 `-`，頭尾的 `- . _` 拿掉，截到 63 字；
 * 什麼都不剩 = `device`。/ A valid name from anything (same as the backend's `suggest`).
 */
export function suggestTunnelName(raw: string): string {
    let out = "";
    for (const c of Array.from(raw.trim())) {
        if (allowed(c)) out += c;
        else if (!out.endsWith("-")) out += "-";
    }
    const trimmed = out.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    const cut = trimmed.slice(0, TUNNEL_NAME_MAX).replace(/[^A-Za-z0-9]+$/, "");
    return cut || "device";
}

/** 只差大小寫就算同一個名稱（ssh 連線時轉小寫）。/ Names that differ only in case are the same name. */
export function sameTunnelName(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}
