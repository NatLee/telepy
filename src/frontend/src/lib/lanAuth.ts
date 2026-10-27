/**
 * 區網主機那一跳怎麼登入（純函式）：Telepy 的金鑰（預設）、在終端機裡問密碼、或憑證庫裡存的 ssh 登入。
 * 三種表示法：網址參數（`lanAuth=prompt` / `lanAuth=cred:12`）、select 的值、WebSocket auth 訊息的欄位。
 * How the LAN hop logs in (pure): Telepy's key (default), a password prompt in the terminal, or a saved ssh login
 * from the vault. Three encodings: the URL param (`lanAuth=prompt` / `lanAuth=cred:12`), the select value, and
 * the WebSocket auth frame's fields.
 */

export type LanAuth = { kind: "telepy" } | { kind: "prompt" } | { kind: "credential"; id: number };

export const TELEPY_AUTH: LanAuth = { kind: "telepy" };

/** select 的值 / 網址參數（Telepy = 預設，不帶）。/ The select value / URL param (the default carries nothing). */
export function lanAuthValue(a: LanAuth): string {
    if (a.kind === "prompt") return "prompt";
    if (a.kind === "credential") return `cred:${a.id}`;
    return "telepy";
}

export function lanAuthFromValue(v: string | null | undefined): LanAuth {
    if (v === "prompt") return { kind: "prompt" };
    const m = /^cred:(\d+)$/.exec(v ?? "");
    if (m) return { kind: "credential", id: Number(m[1]) };
    return TELEPY_AUTH;
}

/** 網址要帶的值（預設不帶）。/ The URL param, or undefined for the default. */
export function lanAuthParam(a: LanAuth): string | undefined {
    return a.kind === "telepy" ? undefined : lanAuthValue(a);
}

/** auth 訊息的欄位（`lan_auth` + `lan_credential_id`）。/ The auth frame's fields. */
export function lanAuthFrame(a: LanAuth): { lan_auth: string; lan_credential_id?: string } {
    if (a.kind === "credential") return { lan_auth: "credential", lan_credential_id: String(a.id) };
    return { lan_auth: a.kind };
}
