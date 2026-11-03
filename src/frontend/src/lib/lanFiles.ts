/**
 * 區網主機的檔案（純函式）：打開 session 的請求內容、錯誤碼 → 翻譯 key、什麼時候可以改用密碼。
 * 打開之後，檔案管理把 `session`（`~…`）放在帳號的位置，其他都跟裝置的檔案一樣。
 * A LAN host's files (pure): the open request, error codes → keys, when typing a password is the way out. Once open,
 * the file manager puts `session` (`~…`) where the account goes; everything else is the device's file manager.
 */
import type { LanAuth } from "./lanAuth.ts";
import type { TranslationKey } from "@/locales/en";

export interface LanFilesSession {
    session: string;
    tunnel_id: number;
    host_id: number;
    address: string;
    ssh_port: number;
    login: string;
    account: string;
    auth: string;
    fingerprint: string;
    idle_secs: number;
    closes_after_secs: number;
}

/** 這種登入方式要不要先打密碼（「在終端機裡問」= 這裡問）。/ Whether this login method needs a typed password. */
export function needsPassword(auth: LanAuth): boolean {
    return auth.kind === "prompt";
}

/** `POST …/lan/hosts/{id}/files` 的內容。/ The open request's body. */
export function openBody(auth: LanAuth, login: string, account: string | null, password = ""): Record<string, unknown> {
    const base: Record<string, unknown> = { login: login.trim() };
    if (account) base.account = account;
    if (auth.kind === "prompt") return { ...base, auth: "password", password };
    if (auth.kind === "credential") return { ...base, auth: "credential", credential_id: auth.id };
    return { ...base, auth: "telepy" };
}

const ERRORS: Record<string, TranslationKey> = {
    lan_files_login: "lanFiles.err.login",
    lan_files_no_sftp: "lanFiles.err.noSftp",
    lan_files_failed: "lanFiles.err.failed",
    lan_login_required: "lanFiles.err.loginRequired",
    lan_login: "lanFiles.err.loginInvalid",
    lan_password: "lanFiles.err.password",
    lan_credential: "lanFiles.err.credential",
    device_offline: "lanFiles.err.offline",
    no_account: "lanFiles.err.noAccount",
    feature_disabled: "lanFiles.err.feature",
};

export function lanFilesErrorKey(code: string | null | undefined): TranslationKey | null {
    return code ? ERRORS[code] ?? null : null;
}

/** 那台主機不收 Telepy 的金鑰 / 存的登入：提議改打密碼。/ The host refused the key or saved login: offer a password. */
export function offerPassword(code: string | null | undefined, auth: LanAuth): boolean {
    return code === "lan_files_login" && auth.kind !== "prompt";
}

/** 錯誤的原文要不要也顯示（後端說了哪台、為什麼）。/ Whether the backend's own words add something. */
export function showDetail(code: string | null | undefined): boolean {
    return code === "lan_files_failed" || code === "lan_files_login" || !lanFilesErrorKey(code);
}

/**
 * 後端說的登入方式（`Telepy's key` / `a password` / `saved login '<名字>'`）→ 翻譯；認不得就原文。
 * The backend's login method words → a translation key (+ vars); unknown words stay as they are.
 */
export function authLabel(auth: string): { key: TranslationKey; vars?: Record<string, string> } | null {
    if (auth === "Telepy's key") return { key: "lanAuth.telepy" };
    if (auth === "a password") return { key: "lanFiles.authPassword" };
    const m = /^saved login '(.*)'$/.exec(auth);
    if (m) return { key: "lanAuth.savedOption", vars: { name: m[1] } };
    return null;
}
