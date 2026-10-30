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

import { tidyConfig } from "./sshConfigTidy.ts";

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
// 簡化寫法裡同一台 Telepy 的裝置共用的區塊（`lib/sshConfigTidy.ts`）叫 `telepy shared <伺服器別名>`：兩個字的名字，
// 舊版的指令只認一個字，所以碰不到它。/ The block a server's devices share in the compact form is named `telepy shared
// <server alias>`: two words, which older commands (one word) never touch.

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
function stripAwk(aliases: string[], exclude = false, server?: string | null): string {
    // exclude：`$telepy_skip` 裡的別名（別台 Telepy 的同名區塊）不拿掉。/ exclude: aliases in `$telepy_skip` stay.
    const skip = exclude ? ` -v x="$telepy_skip"` : "";
    const drop = exclude ? `;m=split(x,X," ");for(i=1;i<=m;i++)delete K[X[i]]` : "";
    // 這台的共用區塊（`telepy shared <server>`）：Host 行拿掉這些別名，沒有名字了整段拿掉；沒有結尾標記的原樣印回去。
    // This server's shared blocks: drop these aliases from the Host line, the whole block once no name is left; an
    // unterminated one is printed back as it was.
    const shared = server
        ? [
            ` -v M='${server}'`,
            `;SO="# >>> telepy shared " M " >>>";SC="# <<< telepy shared " M " <<<"`,
            `h{if($0==SC){if(!hl||k)printf "%s%s\\n",hb,$0;h=0;next} if($0~/^# >>> telepy /){printf "%s",hr;h=0} else {hr=hr $0 "\\n";if(tolower($1)=="host"){hl=1;o=$1;for(i=2;i<=NF;i++)if(!($i in K)){o=o " " $i;k=1};hb=hb o "\\n"}else hb=hb $0 "\\n";next}} `,
            ` !s&&$0==SO{h=1;k=0;hl=0;hb=$0 "\\n";hr=hb;next}`,
            `if(h)printf "%s",hr;`,
        ]
        : ["", "", "", "", ""];
    return `-v t='${aliases.join(" ")}'${skip}${shared[0]} 'BEGIN{n=split(t,A," ");for(i=1;i<=n;i++)K[A[i]]=1${drop}${shared[1]}} ${shared[2]}/^# >>> telepy [^ ]+ >>>$/&&($4 in K){if(s)printf "%s",b;s=1;c=$4;b=""} s{b=b $0 "\\n";if($0=="# <<< telepy " c " <<<"){s=0;b=""};next}${shared[3]} 1;END{if(s)printf "%s",b;${shared[4]}}'`;
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
 * 同名偵測：要寫的裝置別名裡，有哪些已經是「別台 Telepy」的——同名的完整標記區塊，第一行 ProxyCommand（最後一個字）
 * 或 ProxyJump 跳到別的伺服器別名；跳舊版共用別名時看那個共用伺服器區塊的 `HostKeyAlias` 是不是這台（沒有那個區塊 =
 * 這台的）。印出這些別名（空白分隔），標記區塊之外手寫的同名 `Host` 另外在 stderr 提醒。兩遍：第一遍找共用伺服器區塊
 * 的 HostKeyAlias。CLI 的 `sshcfg::foreign_aliases` / `shadowed_aliases` 是同一條規則。
 * Same-name detection: which device aliases about to be written already belong to another Telepy server — a complete
 * marked block of that name whose first ProxyCommand (last word) or ProxyJump goes through a different server alias;
 * for the old shared alias the shared server block's `HostKeyAlias` decides (no such block = ours). Prints them
 * space-separated; hand-written `Host` lines of these names outside Telepy's blocks get a note on stderr. Two passes:
 * the first finds the shared block's HostKeyAlias. The CLI's `sshcfg::foreign_aliases` / `shadowed_aliases` match.
 */
function detectAwk(aliases: string[], me: string, legacy: string): string {
    return `-v t='${aliases.join(" ")}' -v M='${me}' -v L='${legacy}' 'BEGIN{n=split(t,A," ");for(i=1;i<=n;i++)K[A[i]]=1;LO="# >>> telepy " L " >>>";LC="# <<< telepy " L " <<<"} NR==FNR{if($0==LO){l=1;c="";next} if(l&&$0==LC){l=0;if(lh=="")lh=c;next} if(l&&c==""&&tolower($1)=="hostkeyalias")c=$2;next} /^# >>> telepy shared [^ ]+ >>>$/{sh=1;next} sh{if($0~/^# <<< telepy shared /)sh=0;next} /^# >>> telepy [^ ]+ >>>$/{a=$4;ins=1;b=(a in K)&&a!=M&&a!=L;j="";next} ins&&$0=="# <<< telepy " a " <<<"{ins=0;if(b&&j!=""&&j!=M&&!(j==L&&(lh==""||lh==M))&&!(a in S)){S[a]=1;o=o a " "};b=0;next} ins{if(b&&j==""&&tolower($1)=="proxycommand")j=$NF;if(b&&j==""&&tolower($1)=="proxyjump")j=$2;next} tolower($1)=="host"{for(i=2;i<=NF;i++)if($i in K)H[$i]=1} END{for(h in H)if(!(h in S))printf "Telepy: ~/.ssh/config also has its own Host %s outside the Telepy blocks; ssh uses whichever comes first.\\n",h > "/dev/stderr";printf "%s",o}'`;
}

/**
 * 從要加的區塊裡拿掉 `$telepy_skip` 裡的別名：它們的區塊，以及共用區塊 Host 行上的名字（沒有名字了整段不加）。
 * Drops the aliases in `$telepy_skip` from what gets appended: their blocks, and their names on shared blocks' Host
 * lines (a shared block left with no name is not appended).
 */
const FILTER_AWK = `'BEGIN{n=split(x,A," ");for(i=1;i<=n;i++)X[A[i]]=1} /^# >>> telepy shared [^ ]+ >>>$/{h=1;k=0;hb=$0 "\\n";next} h{if($0~/^# <<< telepy shared /){h=0;if(k)printf "%s%s\\n",hb,$0;next} if(tolower($1)=="host"){o=$1;for(i=2;i<=NF;i++)if(!($i in X)){o=o " " $i;k=1};hb=hb o "\\n"}else hb=hb $0 "\\n";next} /^# >>> telepy [^ ]+ >>>$/{s=($4 in X)} !s{print} /^# <<< telepy [^ ]+ <<<$/{s=0}'`;

/** 同一套同名偵測的 PowerShell 版（對讀進來的 `$text`；結果在 `$skip` 與 `$keep`）。/ The same detection in PowerShell. */
function detectPowershell(aliases: string[], me: string, legacy: string): string[] {
    return [
        `$names = @(${aliases.map((a) => `'${a}'`).join(", ")}); $me = '${me}'; $L = '${legacy}'`,
        `$blocks = [regex]::Matches($text, '(?ms)^# >>> telepy (\\S+) >>>[^\\S\\n]*\\n((?:(?!^# >>> telepy ).)*?)^# <<< telepy \\1 <<<')`,
        `$lh = ''; foreach ($b in $blocks) { if ($b.Groups[1].Value -eq $L -and $b.Groups[2].Value -match '(?m)^\\s*HostKeyAlias\\s+(\\S+)') { $lh = $Matches[1]; break } }`,
        `$skip = @(); foreach ($b in $blocks) { $a = $b.Groups[1].Value; if ($names -notcontains $a -or $a -eq $me -or $a -eq $L -or $skip -contains $a) { continue }; if ($b.Groups[2].Value -match '(?m)^\\s*(?:ProxyCommand\\s.*\\s(\\S+)|ProxyJump\\s+(\\S+))\\s*$') { $j = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }; if ($j -ne $me -and -not ($j -eq $L -and ($lh -eq '' -or $lh -eq $me))) { $skip += $a } } }`,
        `$keep = @($names | Where-Object { $skip -notcontains $_ })`,
        `$outside = [regex]::Replace($text, '(?ms)^# >>> telepy (\\S+(?: \\S+)?) >>>.*?^# <<< telepy \\1 <<<', '')`,
        `foreach ($m in [regex]::Matches($outside, '(?m)^\\s*Host\\s+(.+?)\\s*$')) { foreach ($h in ($m.Groups[1].Value -split '\\s+')) { if ($keep -contains $h) { Write-Warning "Telepy: ~/.ssh/config also has its own Host $h outside the Telepy blocks; ssh uses whichever comes first." } } }`,
    ];
}

/** 別台 Telepy 的同名裝置沒覆蓋時給的提示（指令裡的英文，網頁另有說明）。/ The note when same-name devices were kept. */
const KEPT_NOTE = "another Telepy server already uses these names here. Set a name prefix for this server in the Telepy SSH config dialog, then run the new command.";

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
export function installCommand(shell: ConfigShell, stanzas: ConfigStanza[], knownHosts?: string | null, wsClient?: WsClient | null, legacy?: LegacyServer | null, opts: InstallOptions = {}): string {
    const aliases = stanzas.map((s) => s.alias);
    const blocks = opts.blocks ?? (opts.compact ? compactBlocks(adaptForShell(stanzas, shell)) : markedBlocks(adaptForShell(stanzas, shell)));
    // 這台的共用區塊：要寫的別名從它的 Host 行拿掉（不管這次寫不寫簡化版）。/ This server's shared blocks lose these names.
    const server = opts.server ?? legacy?.me ?? null;
    const hostKeys = knownHosts?.trim() ? knownHosts.trim() + "\n" : "";
    const keyAliases = knownHostAliases(hostKeys);
    const prune = legacy && legacy.alias && legacy.alias !== legacy.me && aliases.includes(legacy.me) ? legacy : null;
    // 知道這台的伺服器別名時才偵測同名（別台 Telepy 的同名裝置不覆蓋）。/ Same-name detection needs this server's alias.
    const detect = legacy && aliases.includes(legacy.me) ? legacy : null;
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
            ...(detect ? [`  && telepy_skip=$(awk ${detectAwk(aliases, detect.me, detect.alias)} ~/.ssh/config.bak ~/.ssh/config.bak) \\`] : []),
            `  && awk ${stripAwk(aliases, !!detect, server)} ~/.ssh/config.bak > ~/.ssh/config \\`,
            detect ? `  && awk -v x="$telepy_skip" ${FILTER_AWK} >> ~/.ssh/config <<'${HEREDOC}'` : `  && cat >> ~/.ssh/config <<'${HEREDOC}'`,
            blocks + HEREDOC,
            ...(detect ? [`[ -z "$telepy_skip" ] || echo "Telepy: did not overwrite $telepy_skip- ${KEPT_NOTE}" >&2`] : []),
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
        ...(detect
            ? [
                ...detectPowershell(aliases, detect.me, detect.alias),
                `if ($keep.Count) { $g = '(' + (($keep | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')'; $text = [regex]::Replace($text, "(?ms)^# >>> telepy $g >>>[^\\S\\n]*\\n(?:(?!^# >>> telepy ).)*?^# <<< telepy \\1 <<<[^\\S\\n]*(\\n|\\z)", '') }`,
            ]
            : [`$text = [regex]::Replace($text, '${stripRegex(aliases)}', '')`]),
        ...(server ? releaseSharedPowershell("$text", server, detect ? "$keep" : `@(${aliases.map((a) => `'${a}'`).join(", ")})`) : []),
        "if ($text -and -not $text.EndsWith(\"`n\")) { $text += \"`n\" }",
        "$new = @'",
        blocks + "'@ + \"`n\"",
        ...(detect ? [`foreach ($a in $skip) { $e = [regex]::Escape($a); $new = [regex]::Replace($new, "(?ms)^# >>> telepy $e >>>\\r?\\n.*?^# <<< telepy $e <<<\\r?\\n?", '') }`] : []),
        ...(detect && server && opts.compact ? releaseSharedPowershell("$new", server, "$skip") : []),
        "$text += $new",
        ...(prune ? pruneLegacyPowershell(prune.alias, prune.me) : []),
        "[IO.File]::WriteAllText($cfg, $text)",
        ...(detect ? [`if ($skip.Count) { Write-Warning "Telepy: did not overwrite $($skip -join ', ') - ${KEPT_NOTE}" }`] : []),
    ].join("\n") + "\n";
}

/**
 * 只拿掉這些別名的區塊（伺服器區塊留著，其他裝置還要用）；`server` 有給時，這台共用區塊的 Host 行也拿掉這些名字。
 * Remove just these aliases' blocks (the server block stays); with `server`, their names also leave this server's
 * shared blocks.
 */
export function removeCommand(shell: ConfigShell, aliases: string[], server?: string | null): string {
    if (shell === "posix") {
        return `cp ~/.ssh/config ~/.ssh/config.bak && awk ${stripAwk(aliases, false, server)} ~/.ssh/config.bak > ~/.ssh/config\n`;
    }
    return [
        `$cfg = "$HOME\\.ssh\\config"; Copy-Item $cfg "$cfg.bak" -Force`,
        `$text = [regex]::Replace([IO.File]::ReadAllText($cfg), '${stripRegex(aliases)}', '')`,
        ...(server ? releaseSharedPowershell("$text", server, `@(${aliases.map((a) => `'${a}'`).join(", ")})`) : []),
        "[IO.File]::WriteAllText($cfg, $text)",
    ].join("\n") + "\n";
}

/**
 * PowerShell 版：`variable` 裡這台的共用區塊，Host 行拿掉 `names`（一個陣列運算式），沒有名字了整段拿掉。
 * The PowerShell form: in `variable`, this server's shared blocks lose `names` (an array expression) from their Host
 * line, and go entirely once no name is left.
 */
function releaseSharedPowershell(variable: string, server: string, names: string): string[] {
    return [
        `$drop = ${names}; $S = [regex]::Escape('${server}')`,
        `${variable} = [regex]::Replace(${variable}, "(?ms)^# >>> telepy shared $S >>>[^\\S\\n]*\\n(?:(?!^# >>> telepy ).)*?^# <<< telepy shared $S <<<[^\\S\\n]*(\\n|\\z)", { param($m) $hl = $false; $k = $false; $out = foreach ($l in ($m.Value -split "\`n")) { if ($l -match '^\\s*Host\\s+(.*?)\\s*$') { $hl = $true; $names = @($Matches[1] -split '\\s+' | Where-Object { $drop -notcontains $_ }); if ($names.Count) { $k = $true; 'Host ' + ($names -join ' ') } } else { $l } }; if ($hl -and -not $k) { '' } else { $out -join "\`n" } })`,
    ];
}

/** 安裝指令的選項。/ Install command options. */
export interface InstallOptions {
    /** 寫簡化版：同一台伺服器的裝置共用的行放進一個共用區塊（`lib/sshConfigTidy.ts`）。/ Write the compact form. */
    compact?: boolean;
    /** 這台的伺服器別名（共用區塊的名字）；沒給就用 `legacy.me`。/ This server's alias (names its shared blocks). */
    server?: string | null;
    /** 已經算好的區塊文字（照 `shell` 調整過；畫面已經算過簡化版時不用再算一次）。/ Blocks already rendered for `shell`. */
    blocks?: string;
}

/**
 * 簡化版的區塊：每台裝置還是自己的標記區塊（重跑、移除照舊），共用的行搬進 `telepy shared <伺服器>`；驗證不過就用原本的。
 * The compact blocks: every device keeps its own marked block (re-running and removing work as before) and the
 * shared lines move into `telepy shared <server>`; if the check fails, the plain blocks are used.
 */
export function compactBlocks(stanzas: ConfigStanza[]): string {
    return compactMarked(markedBlocks(stanzas));
}

/** 同上，但從 [`markedBlocks`] 的文字開始。/ The same, starting from [`markedBlocks`] text. */
export function compactMarked(plain: string): string {
    const r = tidyConfig(plain);
    return r.failed.length ? plain : r.text;
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
