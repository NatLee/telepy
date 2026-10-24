/**
 * ~/.ssh/config 的 Host 區塊與「一行指令寫進 config」（純函式，不碰 React）。
 * 指令把每個區塊包在 `# >>> telepy <別名> >>>` / `# <<< telepy <別名> <<<` 標記之間：再跑一次會先拿掉同名的舊區塊再加上新的，
 * 所以可以重複執行、伺服器位址變了也能更新；寫入前先備份成 config.bak。只拿掉頭尾標記都在的完整區塊——
 * 使用者把結尾標記刪掉時，那段原樣保留，不會把後面的設定一起吃掉。
 * Host stanzas for ~/.ssh/config and one-command installers (pure, no React). Each stanza is wrapped in
 * `# >>> telepy <alias> >>>` / `# <<< telepy <alias> <<<` markers: running the command again first drops the old
 * block with the same alias, so it is safe to repeat and picks up a changed server address; the old file is kept as
 * config.bak. Only complete blocks (both markers present) are removed — if the user deleted an end marker, that part
 * stays as it is instead of swallowing the rest of the file.
 */

export interface ConfigOption {
    key: string;
    value: string;
}

export interface ConfigStanza {
    /** Host 別名。/ The Host alias. */
    alias: string;
    options: ConfigOption[];
}

/** posix = macOS / Linux 的 sh、bash、zsh；powershell = Windows。/ Which shell the command is for. */
export type ConfigShell = "posix" | "powershell";

/**
 * 後端的 config 文字 → Host 區塊（拿掉 `# ===` 標題註解與空行，多餘空白收成一格）。
 * The backend's config text → Host stanzas (banner comments and blank lines dropped, whitespace collapsed).
 */
export function parseStanzas(text: string): ConfigStanza[] {
    const out: ConfigStanza[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^(\S+)\s+(.+)$/.exec(line);
        if (!m) continue;
        const value = m[2].trim().replace(/\s+/g, " ");
        if (m[1].toLowerCase() === "host") out.push({ alias: value, options: [] });
        else out[out.length - 1]?.options.push({ key: m[1], value });
    }
    return out;
}

/** 一個區塊的 config 文字（結尾有換行）。/ One stanza as config text (newline-terminated). */
export function stanzaText(s: ConfigStanza): string {
    return [`Host ${s.alias}`, ...s.options.map((o) => `    ${o.key} ${o.value}`)].join("\n") + "\n";
}

const openMarker = (alias: string) => `# >>> telepy ${alias} >>>`;
const closeMarker = (alias: string) => `# <<< telepy ${alias} <<<`;

/** 加上標記的區塊（指令寫進檔案的內容）。/ The marked blocks the command writes. */
export function markedBlocks(stanzas: ConfigStanza[]): string {
    return stanzas.map((s) => `${openMarker(s.alias)}\n${stanzaText(s)}${closeMarker(s.alias)}\n`).join("");
}

/**
 * 別名的正規式交替 `(a|b)`。別名只有 [A-Za-z0-9._-]（後端 sanitize_host_alias），只需跳脫點號；awk 的 ERE 和 .NET 通用。
 * Regex alternation of the aliases. Aliases are [A-Za-z0-9._-] (backend sanitize_host_alias), so only dots need
 * escaping; the result works in awk ERE and .NET alike.
 */
function aliasGroup(aliases: string[]): string {
    return `(${aliases.map((a) => a.replace(/\./g, "\\.")).join("|")})`;
}

/**
 * awk 程式：照抄每一行，但標記之間的完整區塊丟掉；沒有結尾標記的話，緩衝的內容在檔尾原樣印回去。
 * awk program: copy every line except complete marked blocks; an unterminated block is printed back unchanged.
 */
function stripAwk(aliases: string[]): string {
    const g = aliasGroup(aliases);
    return `/^# >>> telepy ${g} >>>$/{if(s)printf "%s",b;s=1;b=""} s{b=b $0 "\\n";if($0~/^# <<< telepy ${g} <<<$/){s=0;b=""};next} 1;END{if(s)printf "%s",b}`;
}

/**
 * .NET 正規式：開頭標記到同名的結尾標記（含行尾）。中間不能跨過另一個開頭標記，否則沒有結尾的舊區塊會一路吃到後面別的區塊。
 * .NET regex: an open marker through its matching close marker, never across another open marker — otherwise an
 * unterminated old block would swallow everything up to a later block's end marker.
 */
function stripRegex(aliases: string[]): string {
    return `(?ms)^# >>> telepy ${aliasGroup(aliases)} >>>[^\\S\\n]*\\n(?:(?!^# >>> telepy ).)*?^# <<< telepy \\1 <<<[^\\S\\n]*(\\n|\\z)`;
}

// heredoc 結尾字：區塊裡不會有單獨一行 TELEPY（Host 行和縮排過的設定都不是）。/ Never a line of its own in a stanza.
const HEREDOC = "TELEPY";

/**
 * 建立 ~/.ssh（和 config，權限 600——群組可寫的 config 會讓 ssh 直接拒絕）、備份、拿掉舊區塊、加上新區塊。
 * Create ~/.ssh and the config (mode 600 — ssh refuses a group-writable config), back it up, drop old blocks,
 * append the new ones.
 */
export function installCommand(shell: ConfigShell, stanzas: ConfigStanza[]): string {
    const aliases = stanzas.map((s) => s.alias);
    const blocks = markedBlocks(stanzas);
    if (shell === "posix") {
        return [
            "mkdir -p ~/.ssh && touch ~/.ssh/config && chmod 600 ~/.ssh/config \\",
            "  && cp ~/.ssh/config ~/.ssh/config.bak \\",
            `  && awk '${stripAwk(aliases)}' ~/.ssh/config.bak > ~/.ssh/config \\`,
            `  && cat >> ~/.ssh/config <<'${HEREDOC}'`,
            blocks + HEREDOC,
        ].join("\n") + "\n";
    }
    // [IO.File] 讀寫：ReadAllText 會吃掉 BOM、WriteAllText 寫出不帶 BOM 的 UTF-8（Windows OpenSSH 讀到 BOM 會報錯）。
    // [IO.File]: ReadAllText drops a BOM and WriteAllText writes UTF-8 without one (Windows OpenSSH chokes on a BOM).
    return [
        `$cfg = "$HOME\\.ssh\\config"; New-Item -ItemType Directory -Force "$HOME\\.ssh" | Out-Null`,
        `$text = ''; if (Test-Path $cfg) { Copy-Item $cfg "$cfg.bak" -Force; $text = [IO.File]::ReadAllText($cfg) }`,
        `$text = [regex]::Replace($text, '${stripRegex(aliases)}', '')`,
        "if ($text -and -not $text.EndsWith(\"`n\")) { $text += \"`n\" }",
        "[IO.File]::WriteAllText($cfg, $text + @'",
        blocks + "'@ + \"`n\")",
    ].join("\n") + "\n";
}

/**
 * 只拿掉這些別名的區塊（伺服器區塊留著，其他裝置還要用）。/ Remove just these aliases' blocks (the server block stays).
 */
export function removeCommand(shell: ConfigShell, aliases: string[]): string {
    if (shell === "posix") {
        return `cp ~/.ssh/config ~/.ssh/config.bak && awk '${stripAwk(aliases)}' ~/.ssh/config.bak > ~/.ssh/config\n`;
    }
    return [
        `$cfg = "$HOME\\.ssh\\config"; Copy-Item $cfg "$cfg.bak" -Force`,
        `[IO.File]::WriteAllText($cfg, [regex]::Replace([IO.File]::ReadAllText($cfg), '${stripRegex(aliases)}', ''))`,
    ].join("\n") + "\n";
}

/** 手動貼上時開檔的指令。/ The command that opens the file for pasting by hand. */
export function openEditorCommand(shell: ConfigShell): string {
    return shell === "posix"
        ? "mkdir -p ~/.ssh && nano ~/.ssh/config"
        : `New-Item -ItemType Directory -Force "$HOME\\.ssh" | Out-Null; notepad "$HOME\\.ssh\\config"`;
}

/** 依瀏覽器猜作業系統（只當預設值）。/ Guess the shell from the browser (a default only). */
export function guessShell(): ConfigShell {
    if (typeof navigator === "undefined") return "posix";
    return /Windows/i.test(navigator.userAgent) ? "powershell" : "posix";
}
