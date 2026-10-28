/**
 * 怎麼認出 `telepy` CLI：它的瀏覽器登入註冊成 OAuth app，名字是 `telepy CLI (<hostname>)`（`src/cli/src/oauth.rs`）。
 * 單獨一個小檔，讓登入頁不必載入整份 CLI 說明（`cliGuide.ts` 轉出同一個函式）。名字是對方自己報的，所以只拿來決定
 * 畫面與文字，不拿來決定權限。
 * How the `telepy` CLI is recognised: its browser sign-in registers as an OAuth app named `telepy CLI (<hostname>)`
 * (`src/cli/src/oauth.rs`). A file of its own so the sign-in pages don't load the whole CLI guide (`cliGuide.ts`
 * re-exports it). The name is self-declared, so it only picks a look and wording, never permissions.
 */
const CLI_CLIENT = /^telepy CLI(?: \((.+)\))?$/;

/** 這個 app（grant / OAuth 要求）是不是 CLI；是的話回電腦名稱（可能是空字串）。/ Whether it is the CLI; returns the host name. */
export function cliHost(clientName: string | null | undefined): string | null {
    const m = CLI_CLIENT.exec((clientName ?? "").trim());
    return m ? (m[1] ?? "") : null;
}
