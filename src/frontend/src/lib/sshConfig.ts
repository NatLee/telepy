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
 * awk 的參數：照抄每一行，但標記之間的完整區塊丟掉；沒有結尾標記的話，緩衝的內容在檔尾原樣印回去。別名用 `-v` 傳成
 * 一串、在 BEGIN 拆成集合逐行查——一次放幾百台時，macOS 的 awk 處理一個超長的 `(a|b|…)` 正規式要好幾秒。
 * awk arguments: copy every line except complete marked blocks; an unterminated block is printed back unchanged.
 * The aliases go in once through `-v` and become a set in BEGIN — with hundreds of devices, macOS awk took seconds
 * on one huge `(a|b|…)` regex.
 */
function stripAwk(aliases: string[]): string {
    return `-v t='${aliases.join(" ")}' 'BEGIN{n=split(t,A," ");for(i=1;i<=n;i++)K[A[i]]=1} /^# >>> telepy [^ ]+ >>>$/&&($4 in K){if(s)printf "%s",b;s=1;c=$4;b=""} s{b=b $0 "\\n";if($0=="# <<< telepy " c " <<<"){s=0;b=""};next} 1;END{if(s)printf "%s",b}'`;
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

/** 筆電上存 Telepy 主機金鑰的檔（伺服器區塊的 UserKnownHostsFile）。/ Where the laptop keeps Telepy's host key. */
export const KNOWN_HOSTS_PATH = "~/.ssh/telepy_known_hosts";
const KNOWN_HOSTS_HEREDOC = "TELEPY_HOST_KEYS";

/** SSH over WebSocket 的小程式：從哪裡下載、存到哪裡。/ The WebSocket carrier: where to fetch it and where it lives. */
export interface WsClient {
    url: string;
    path: string;
    wsUrl: string;
}

/**
 * 後端給的 ProxyCommand 是 POSIX 寫法（`python3 ~/.ssh/telepy-ws.py …`）；Windows 的 OpenSSH 用 `python` 和 `%d`。
 * The backend writes the POSIX ProxyCommand; Windows OpenSSH wants `python` and `%d` for the home directory.
 */
export function adaptForShell(stanzas: ConfigStanza[], shell: ConfigShell): ConfigStanza[] {
    if (shell !== "powershell") return stanzas;
    return stanzas.map((s) => ({
        ...s,
        options: s.options.map((o) => (o.key.toLowerCase() === "proxycommand" && o.value.startsWith("python3 ~/.ssh/telepy-ws.py ") ? { ...o, value: o.value.replace(/^python3 ~\/\.ssh\/telepy-ws\.py /, "python %d/.ssh/telepy-ws.py ") } : o)),
    }));
}

/**
 * known_hosts 行裡的別名（第一欄，去重）。/ The aliases (first field, unique) of known_hosts lines.
 */
function knownHostAliases(lines: string): string[] {
    return [...new Set(lines.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean))];
}

/**
 * 舊版共用的伺服器區塊（`telepy-ssh-server`）怎麼清：第一個寫著 `HostKeyAlias <me>` 的完整標記區塊，而且檔案裡其他
 * 非註解行都沒有再用這個名字（ProxyCommand / ProxyJump / Host…）時才拿掉——一定是這台的，也沒有裝置區塊還指著它。
 * 兩遍 awk：第一遍找區塊、看有沒有人用，第二遍照行號略過。CLI 的 `prune_legacy`（Rust）是同一條規則。
 * How the old shared server block is cleaned up: the first complete marked block that says `HostKeyAlias <me>` goes
 * only when no other non-comment line in the file names it (ProxyCommand / ProxyJump / Host …) — provably this
 * server's, and no device block still jumps through it. Two awk passes: find the block and look for users, then skip
 * it by line number. The CLI's `prune_legacy` (Rust) follows the same rule.
 */
function pruneLegacyAwk(legacy: string, me: string): string {
    return `-v L='${legacy}' -v M='${me}' 'function u(t, n,i,W){if(t~/^[ \\t]*#/)return;n=split(t,W,/[ \\t,]+/);for(i=1;i<=n;i++)if(W[i]==L)used=1} BEGIN{O="# >>> telepy " L " >>>";C="# <<< telepy " L " <<<"} NR==FNR{if(!ce&&!st&&$0==O){st=1;bs=FNR;bn=0;mb=0;next} if(st){if($0==C){st=0;if(mb){cs=bs;ce=FNR}else{for(i=1;i<=bn;i++)u(B[i])};next} if($0~/^# >>> telepy /){st=0;for(i=1;i<=bn;i++)u(B[i])}else{B[++bn]=$0;if(tolower($1)=="hostkeyalias"&&$2==M)mb=1;next}} u($0);next} FNR==1{if(st)for(i=1;i<=bn;i++)u(B[i]);d=(ce&&!used)} !(d&&FNR>=cs&&FNR<=ce)'`;
}

/** 同一條規則的 PowerShell 版（在寫回檔案前對 `$text` 做）。/ The same rule in PowerShell, applied to `$text` before writing. */
function pruneLegacyPowershell(legacy: string, me: string): string[] {
    return [
        `$L = [regex]::Escape('${legacy}'); $M = [regex]::Escape('${me}')`,
        `$blk = [regex]::Matches($text, "(?ms)^# >>> telepy $L >>>[^\\S\\n]*\\n(?:(?!^# >>> telepy ).)*?^# <<< telepy $L <<<[^\\S\\n]*(\\n|\\z)") | Where-Object { $_.Value -match "(?m)^\\s*HostKeyAlias\\s+$M\\s*$" } | Select-Object -First 1`,
        `if ($blk) { $rest = $text.Remove($blk.Index, $blk.Length); if ($rest -notmatch "(?m)^(?!\\s*#)[^\\n]*(?<![^\\s,])$L(?![^\\s,])") { $text = $rest } }`,
    ];
}

/** 舊版的共用伺服器區塊名稱與這台的（`me`）；兩個一樣 = 舊版伺服器，不清。/ The old shared alias and this server's. */
export interface LegacyServer {
    alias: string;
    me: string;
}

/**
 * 建立 ~/.ssh（和 config，權限 600——群組可寫的 config 會讓 ssh 直接拒絕）、備份、拿掉舊區塊、加上新區塊。
 * `knownHosts`（後端給的 `<alias> <type> <base64>` 行）有內容時先合併進 ~/.ssh/telepy_known_hosts：只換掉同一個別名
 * 的舊行（別台 Telepy 的留著），伺服器區塊用它釘住 Telepy 的主機金鑰。`legacy` 有給時，最後依
 * [`pruneLegacyAwk`] 的規則清掉舊版共用的伺服器區塊。
 * Create ~/.ssh and the config (mode 600 — ssh refuses a group-writable config), back it up, drop old blocks,
 * append the new ones. With `knownHosts` (the backend's `<alias> <type> <base64>` lines) they are merged into
 * ~/.ssh/telepy_known_hosts first — only lines of the same alias are replaced, other Telepy servers' stay — and the
 * server stanza pins Telepy's host key with them. With `legacy`, the old shared server block is cleaned up last by
 * the rule in [`pruneLegacyAwk`].
 */
export function installCommand(shell: ConfigShell, stanzas: ConfigStanza[], knownHosts?: string | null, wsClient?: WsClient | null, legacy?: LegacyServer | null): string {
    const aliases = stanzas.map((s) => s.alias);
    const blocks = markedBlocks(adaptForShell(stanzas, shell));
    const hostKeys = knownHosts?.trim() ? knownHosts.trim() + "\n" : "";
    const keyAliases = knownHostAliases(hostKeys);
    const prune = legacy && legacy.alias && legacy.alias !== legacy.me && aliases.includes(legacy.me) ? legacy : null;
    if (shell === "posix") {
        const kh = KNOWN_HOSTS_PATH;
        return [
            ...(wsClient ? [`mkdir -p ~/.ssh && curl -fsSL '${wsClient.url}' -o ${wsClient.path} && chmod 700 ${wsClient.path}`] : []),
            ...(hostKeys
                ? [
                    `mkdir -p ~/.ssh && touch ${kh} && chmod 600 ${kh}`,
                    `{ awk -v t='${keyAliases.join(" ")}' 'BEGIN{n=split(t,A," ");for(i=1;i<=n;i++)K[A[i]]=1} !($1 in K)' ${kh}; cat <<'${KNOWN_HOSTS_HEREDOC}'; } > ${kh}.new && cat ${kh}.new > ${kh} && rm -f ${kh}.new`,
                    hostKeys + KNOWN_HOSTS_HEREDOC,
                ]
                : []),
            "mkdir -p ~/.ssh && touch ~/.ssh/config && chmod 600 ~/.ssh/config \\",
            "  && cp ~/.ssh/config ~/.ssh/config.bak \\",
            `  && awk ${stripAwk(aliases)} ~/.ssh/config.bak > ~/.ssh/config \\`,
            `  && cat >> ~/.ssh/config <<'${HEREDOC}'`,
            blocks + HEREDOC,
            ...(prune ? [`awk ${pruneLegacyAwk(prune.alias, prune.me)} ~/.ssh/config ~/.ssh/config > ~/.ssh/config.new && cat ~/.ssh/config.new > ~/.ssh/config && rm -f ~/.ssh/config.new`] : []),
        ].join("\n") + "\n";
    }
    // [IO.File] 讀寫：ReadAllText 會吃掉 BOM、WriteAllText 寫出不帶 BOM 的 UTF-8（Windows OpenSSH 讀到 BOM 會報錯）。
    // [IO.File]: ReadAllText drops a BOM and WriteAllText writes UTF-8 without one (Windows OpenSSH chokes on a BOM).
    const keyList = keyAliases.map((a) => `'${a}'`).join(", ");
    return [
        `$cfg = "$HOME\\.ssh\\config"; New-Item -ItemType Directory -Force "$HOME\\.ssh" | Out-Null`,
        ...(wsClient ? [`Invoke-WebRequest -UseBasicParsing '${wsClient.url}' -OutFile "$HOME\\.ssh\\telepy-ws.py"`] : []),
        ...(hostKeys
            ? [
                `$kh = "$HOME\\.ssh\\telepy_known_hosts"; $keep = ''; if (Test-Path $kh) { $keep = ([IO.File]::ReadAllLines($kh) | Where-Object { $_.Trim() -and (@(${keyList}) -notcontains ($_.Trim() -split '\\s+')[0]) }) -join "\`n"; if ($keep) { $keep += "\`n" } }`,
                "[IO.File]::WriteAllText($kh, $keep + @'",
                hostKeys + "'@ + \"`n\")",
            ]
            : []),
        `$text = ''; if (Test-Path $cfg) { Copy-Item $cfg "$cfg.bak" -Force; $text = [IO.File]::ReadAllText($cfg) }`,
        `$text = [regex]::Replace($text, '${stripRegex(aliases)}', '')`,
        "if ($text -and -not $text.EndsWith(\"`n\")) { $text += \"`n\" }",
        "$text += @'",
        blocks + "'@ + \"`n\"",
        ...(prune ? pruneLegacyPowershell(prune.alias, prune.me) : []),
        "[IO.File]::WriteAllText($cfg, $text)",
    ].join("\n") + "\n";
}

/**
 * 只拿掉這些別名的區塊（伺服器區塊留著，其他裝置還要用）。/ Remove just these aliases' blocks (the server block stays).
 */
export function removeCommand(shell: ConfigShell, aliases: string[]): string {
    if (shell === "posix") {
        return `cp ~/.ssh/config ~/.ssh/config.bak && awk ${stripAwk(aliases)} ~/.ssh/config.bak > ~/.ssh/config\n`;
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
