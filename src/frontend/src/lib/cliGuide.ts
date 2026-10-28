/**
 * CLI 頁（`/tunnels/cli`）的純函式：從瀏覽器猜平台、每個平台的下載檔名與安裝指令（GitHub release 的
 * `latest/download/…`，檔名不帶版號——見 `.github/workflows/release-cli.yml`）、用這個人自己的隧道 / 帳號 / 標籤 /
 * 群組 / 片段組出來的範例、指令總表與搜尋、CLI 在 Connected apps 裡的名字。`cliGuide.test.ts` 有測試。
 * 指令與旗標照 `src/cli/src/lib.rs`（clap）；那邊改了，這裡跟著改。
 * Pure helpers for the CLI page: guess the platform from the browser, each platform's download and install
 * command (the GitHub release's `latest/download/…`; names carry no version — see release-cli.yml), examples built
 * from the person's own tunnels / accounts / labels / groups / snippets, the command list and its search, and the
 * name the CLI's browser sign-in has under Connected apps. Commands and flags mirror `src/cli/src/lib.rs` (clap).
 */
import type { TranslationKey } from "../locales/en.ts";
import type { SpotState } from "./flow.ts";
import type { StepState } from "./stepTabs.ts";

export const CLI_REPO = "https://github.com/NatLee/telepy";
export const CLI_RELEASES_URL = `${CLI_REPO}/releases`;

export type CliOs = "macos" | "linux" | "windows";
export type CliArch = "arm64" | "x86_64";

export interface CliPlatform {
    os: CliOs;
    arch: CliArch;
}

/** 這個平台有沒有發行版（Windows 只有 x86_64；ARM 的 Windows 用模擬跑它）。/ Whether a build exists. */
export function archesFor(os: CliOs): CliArch[] {
    return os === "windows" ? ["x86_64"] : ["arm64", "x86_64"];
}

export function cliTarget({ os, arch }: CliPlatform): string {
    if (os === "windows") return "x86_64-pc-windows-msvc";
    const cpu = arch === "arm64" ? "aarch64" : "x86_64";
    return os === "macos" ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-musl`;
}

export function archiveName(p: CliPlatform): string {
    return `telepy-${cliTarget(p)}.${p.os === "windows" ? "zip" : "tar.gz"}`;
}

/** 最新發行版的下載網址（不帶版號，所以永遠是最新的）。/ The newest release's download URL. */
export function downloadUrl(p: CliPlatform): string {
    return `${CLI_RELEASES_URL}/latest/download/${archiveName(p)}`;
}

export interface Snippet {
    language: "bash" | "powershell" | "yaml";
    value: string;
}

/**
 * 一段貼上就裝好的指令：macOS / Linux 下載 → 只解出 `telepy` → 裝到 /usr/local/bin；Windows 解到
 * `%LOCALAPPDATA%\telepy` 並加進使用者的 PATH（已經有就不重複加）。最後印版本確認。
 * One paste installs it: macOS / Linux download → extract only `telepy` → /usr/local/bin; Windows unpacks into
 * `%LOCALAPPDATA%\telepy` and adds it to the user's PATH once. Each ends with the version.
 */
export function installCommand(p: CliPlatform): Snippet {
    const url = downloadUrl(p);
    if (p.os === "windows") {
        return {
            language: "powershell",
            value: [
                `$dir = "$env:LOCALAPPDATA\\telepy"`,
                `Invoke-WebRequest ${url} -OutFile "$env:TEMP\\telepy.zip"`,
                `Expand-Archive "$env:TEMP\\telepy.zip" $dir -Force`,
                `$p = [Environment]::GetEnvironmentVariable("Path", "User")`,
                `if (($p -split ";") -notcontains $dir) { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User") }`,
                `$env:Path += ";$dir"`,
                `telepy --version`,
            ].join("\n"),
        };
    }
    return {
        language: "bash",
        // 新的 Apple silicon Mac 可能還沒有 /usr/local/bin（它在預設的 PATH 裡）。/ A new Mac may lack /usr/local/bin.
        value: [`curl -fsSL ${url} | tar xz telepy`, `sudo mkdir -p /usr/local/bin && sudo install -m 755 telepy /usr/local/bin/ && rm telepy`, `telepy --version`].join("\n"),
    };
}

/** 檢查下載檔：同一個 release 的 `SHA256SUMS`。/ Verify the download against the release's SHA256SUMS. */
export function verifyCommand(p: CliPlatform): Snippet {
    const name = archiveName(p);
    const sums = `${CLI_RELEASES_URL}/latest/download/${name}.sha256`;
    if (p.os === "windows") {
        return {
            language: "powershell",
            // 印出 True 就對了（-eq 不分大小寫）。/ Prints True when it matches (-eq ignores case).
            value: [
                `Invoke-WebRequest ${downloadUrl(p)} -OutFile ${name}`,
                `Invoke-WebRequest ${sums} -OutFile telepy.sha256`,
                `(Get-FileHash ${name} -Algorithm SHA256).Hash -eq (Get-Content telepy.sha256).Split(" ")[0]`,
            ].join("\n"),
        };
    }
    const tool = p.os === "macos" ? "shasum -a 256 -c" : "sha256sum -c";
    return { language: "bash", value: [`curl -fsSLO ${downloadUrl(p)}`, `curl -fsSL ${sums} | ${tool}`].join("\n") };
}

/** 自己編（Rust 1.88 以上）。/ Build it yourself (Rust 1.88 or newer). */
export const CARGO_INSTALL = `cargo install --locked --git ${CLI_REPO} telepy-cli`;

export interface BrowserHints {
    userAgent: string;
    /** `navigator.platform`（舊但到處都有）。/ Old but everywhere. */
    platform?: string;
    /** `navigator.userAgentData.getHighEntropyValues(["architecture"])`（只有 Chromium）："arm" / "x86"。 */
    architecture?: string;
}

/**
 * 從瀏覽器猜平台；`sure` = 架構不是猜的（Chromium 會說，Safari / Firefox 不說：Mac 先假設 Apple silicon）。
 * 手機 / 平板猜不出要裝在哪台電腦，回 macOS 但 `sure: false`。
 * Guess the platform; `sure` = the architecture was reported, not assumed (Chromium tells, Safari / Firefox
 * don't: a Mac is assumed to be Apple silicon). Phones and tablets give macOS with `sure: false`.
 */
export function detectPlatform(h: BrowserHints): CliPlatform & { sure: boolean } {
    const ua = h.userAgent || "";
    const plat = h.platform || "";
    const reported = h.architecture === "arm" ? "arm64" : h.architecture === "x86" ? "x86_64" : null;
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return { os: "macos", arch: "arm64", sure: false };
    if (/Windows/i.test(ua) || /^Win/i.test(plat)) return { os: "windows", arch: "x86_64", sure: true };
    if (/Mac OS X|Macintosh/i.test(ua) || /^Mac/i.test(plat)) return { os: "macos", arch: reported ?? "arm64", sure: reported !== null };
    if (/Linux|X11|CrOS/i.test(ua) || /Linux/i.test(plat)) {
        const fromUa = /aarch64|arm64|armv8/i.test(`${ua} ${plat}`) ? "arm64" : /x86_64|amd64|x64/i.test(`${ua} ${plat}`) ? "x86_64" : null;
        const arch = reported ?? fromUa;
        return { os: "linux", arch: arch ?? "x86_64", sure: arch !== null };
    }
    return { os: "macos", arch: "arm64", sure: false };
}

// ---------------------------------------------------------------- the CLI under Connected apps

/** CLI 的瀏覽器登入註冊成 OAuth app，名字是 `telepy CLI (<hostname>)`（`src/cli/src/oauth.rs`）。 */
const CLI_CLIENT = /^telepy CLI(?: \((.+)\))?$/;

/** 這個 grant 是不是 CLI 的；是的話回電腦名稱（可能是空字串）。/ Whether a grant is the CLI's; returns the host name. */
export function cliHost(clientName: string | null | undefined): string | null {
    const m = CLI_CLIENT.exec((clientName ?? "").trim());
    return m ? (m[1] ?? "") : null;
}

// ---------------------------------------------------------------- examples

/** shell 引號：安全的字元原樣，其他用單引號包起來。/ Shell quoting: safe words stay, others get single quotes. */
export function shq(s: string): string {
    if (/^[A-Za-z0-9._@%+=:,/-]+$/.test(s)) return s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 範例要用的「你的東西」：沒有的欄位就用 `<…>` 佔位。帳號只在那條隧道有好幾個時才寫出來（只有一個就是預設的）。
 * What the examples are built from; a missing one becomes a `<…>` placeholder. The account is only spelled out when
 * the tunnel has several (with one, it is the default anyway).
 */
export interface CliContext {
    base: string;
    tunnel: string | null;
    /** 另一個帳號（不是預設的那個）。/ An account other than the default. */
    account: string | null;
    /** 另一條隧道（同時跑兩台的範例）。/ A second tunnel (the two-device example). */
    other: string | null;
    label: string | null;
    group: string | null;
    snippet: { name: string; vars: string[] } | null;
}

export const PLACEHOLDER = { tunnel: "<tunnel>", account: "<account>", other: "<tunnel2>", label: "<label>", group: "<group>", snippet: "<snippet>" } as const;

/** 範例需要什麼：一個 scope、你的 SSH 金鑰（ssh / scp / sftp 走系統的 OpenSSH）或 API token（`tunnels:manage`）。 */
export type CliNeed = "tunnels:read" | "ssh:exec" | "ssh:files" | "network:scan" | "browser:use" | "tunnels:manage" | "ssh-key";

/** 瀏覽器登入預設要的 scope（`DEFAULT_SCOPE`）；其他的要 `--scope`，`tunnels:manage` 只有 token 有。 */
export const LOGIN_SCOPES: readonly CliNeed[] = ["tunnels:read", "ssh:exec", "ssh:files"];

export type CliTopicId = "everyday" | "many" | "files" | "sessions" | "toolbox" | "network" | "ci";
export const CLI_TOPICS: readonly CliTopicId[] = ["everyday", "many", "files", "sessions", "toolbox", "network", "ci"];

export interface CliRecipe {
    id: string;
    /** `cli.ex.<id>`：標題；`cli.ex.<id>Note`：一句說明。/ The title and its one-line note. */
    title: TranslationKey;
    note: TranslationKey;
    command: Snippet;
    needs: CliNeed[];
    /** 範例裡用了佔位字（沒有真的隧道 / 標籤…）。/ The example uses a placeholder. */
    placeholder: boolean;
}

function sh(value: string): Snippet {
    return { language: "bash", value };
}

/** 一個主題的範例。名字都用 `shq` 包過，所以複製下來就能跑。/ A topic's examples, names shell-quoted. */
export function cliRecipes(topic: CliTopicId, c: CliContext): CliRecipe[] {
    const T = c.tunnel ? shq(c.tunnel) : PLACEHOLDER.tunnel;
    const TA = c.tunnel && c.account ? shq(`${c.tunnel}@${c.account}`) : c.tunnel ? T : `${PLACEHOLDER.tunnel}@${PLACEHOLDER.account}`;
    const T2 = c.other ? shq(c.other) : PLACEHOLDER.other;
    const L = c.label ? shq(c.label) : PLACEHOLDER.label;
    const G = c.group ? shq(c.group) : PLACEHOLDER.group;
    const noTunnel = !c.tunnel;
    const r = (id: string, value: string | Snippet, needs: CliNeed[], placeholder = noTunnel): CliRecipe => ({
        id,
        title: `cli.ex.${id}` as TranslationKey,
        note: `cli.ex.${id}Note` as TranslationKey,
        command: typeof value === "string" ? sh(value) : value,
        needs,
        placeholder,
    });
    switch (topic) {
        case "everyday":
            return [
                r("ls", "telepy ls", ["tunnels:read"], false),
                r("lsJson", "telepy ls --online --json", ["tunnels:read"], false),
                r("status", `telepy status ${T}`, ["tunnels:read"]),
                r("ssh", `telepy ssh ${T}`, ["tunnels:read", "ssh-key"]),
                r("sshAccount", `telepy ssh ${TA} -- uname -a`, ["tunnels:read", "ssh-key"], noTunnel || !c.account),
                r("forward", `telepy ssh ${T} -L 8080:localhost:80`, ["tunnels:read", "ssh-key"]),
                r("configInstall", "telepy config install --all", ["tunnels:read", "ssh-key"], false),
            ];
        case "many":
            return [
                r("exec", `telepy exec ${T} -- uptime`, ["ssh:exec"]),
                r("execTwo", `telepy exec ${T} ${T2} -- df -h /`, ["ssh:exec"], noTunnel || !c.other),
                r("execLabel", `telepy exec --label ${L} -- systemctl is-active nginx`, ["ssh:exec"], !c.label),
                r("execGroup", `telepy exec --group ${G} -- free -h`, ["ssh:exec"], !c.group),
                r("execJson", `telepy exec --label ${L} --json -- hostname`, ["ssh:exec"], !c.label),
                r("execApproval", `telepy exec ${T} --wait-approval -- sudo systemctl restart nginx`, ["ssh:exec"]),
            ];
        case "files":
            return [
                r("cpUp", `telepy cp ./backup.tar.gz ${T}:/tmp/`, ["ssh:files"]),
                r("cpDown", `telepy cp ${T}:/var/log/syslog ./syslog`, ["ssh:files"]),
                r("scp", `telepy scp -r ./site ${T}:~/site`, ["tunnels:read", "ssh-key"]),
                r("sftp", `telepy sftp ${T}`, ["tunnels:read", "ssh-key"]),
            ];
        case "sessions":
            return [
                r("sessions", "telepy sessions", ["tunnels:read"], false),
                r("sessionsEnd", "telepy sessions end 42", ["tunnels:manage"], false),
                r("recordings", `telepy recordings ls --tunnel ${T}`, ["ssh:exec"]),
                r("play", "telepy recordings play 17 --speed 2", ["ssh:exec"], false),
            ];
        case "toolbox": {
            const name = c.snippet ? shq(c.snippet.name) : PLACEHOLDER.snippet;
            const vars = (c.snippet?.vars ?? []).map((v) => ` --var ${shq(v)}=…`).join("");
            return [r("snippets", `telepy snippets ls --tunnel ${T}`, ["ssh:exec"]), r("run", `telepy run ${name} ${T}${vars}`, ["ssh:exec"], noTunnel || !c.snippet)];
        }
        case "network":
            return [
                r("lanLs", `telepy lan ls ${T}`, ["tunnels:read"]),
                r("lanAdd", `telepy lan add ${T} 192.168.1.20 --label nas --user admin`, ["tunnels:manage"]),
                r("browse", `ID=$(telepy browse ${T} http://192.168.1.1/)\ntelepy browse text "$ID" --selector main\ntelepy browse shot "$ID" -o router.png\ntelepy browse close "$ID"`, ["browser:use"]),
                r("browseLogin", `telepy login ${c.base || "<url>"} --scope "tunnels:read ssh:exec ssh:files browser:use"`, ["browser:use"], false),
            ];
        case "ci":
            return [
                r("ciEnv", `export TELEPY_URL=${c.base || "<url>"}\nexport TELEPY_TOKEN=tpt_…\ntelepy exec --label ${L} -- uptime`, ["ssh:exec"], !c.label),
                r("ciActions", { language: "yaml", value: githubActions(c.base, L) }, ["ssh:exec"], !c.label),
                r("activity", "telepy api activity --since 1h --follow", [], false),
            ];
    }
}

/** GitHub Actions 的範例 job：裝 CLI、用 secret 的 token、在有標籤的裝置上部署。/ A GitHub Actions job. */
export function githubActions(base: string, label: string): string {
    const linux = downloadUrl({ os: "linux", arch: "x86_64" });
    return [
        "# .github/workflows/deploy.yml",
        "jobs:",
        "  deploy:",
        "    runs-on: ubuntu-latest",
        "    env:",
        `      TELEPY_URL: ${base || "<url>"}`,
        "      TELEPY_TOKEN: ${{ secrets.TELEPY_TOKEN }}",
        "    steps:",
        "      - name: Install telepy",
        "        run: |",
        `          curl -fsSL ${linux} | tar xz -C "$RUNNER_TEMP" telepy`,
        '          echo "$RUNNER_TEMP" >> "$GITHUB_PATH"',
        "      - name: Deploy",
        `        run: telepy exec --label ${label} -- 'cd /srv/app && git pull && sudo systemctl restart app'`,
    ].join("\n");
}

// ---------------------------------------------------------------- the command list

export interface CliCommand {
    /** 指令（不含 `telepy`）與主要參數。/ The command (without `telepy`) and its main arguments. */
    usage: string;
    /** `cli.cmd.<key>`。 */
    key: string;
    needs: CliNeed[];
}

/** 順序 = `telepy --help`。/ Same order as `telepy --help`. */
export const CLI_COMMANDS: readonly CliCommand[] = [
    { usage: "login <url>", key: "login", needs: [] },
    { usage: "logout", key: "logout", needs: [] },
    { usage: "whoami", key: "whoami", needs: [] },
    { usage: "ls [--label k=v] [--group <g>] [--online]", key: "ls", needs: ["tunnels:read"] },
    { usage: "status <tunnel>", key: "status", needs: ["tunnels:read"] },
    { usage: "ssh <tunnel>[@account] [-L …] [-D …] [-- cmd]", key: "ssh", needs: ["tunnels:read", "ssh-key"] },
    { usage: "scp [-r] <from>… <to>", key: "scp", needs: ["tunnels:read", "ssh-key"] },
    { usage: "sftp <tunnel>[@account]", key: "sftp", needs: ["tunnels:read", "ssh-key"] },
    { usage: "config install [<tunnel>…|--all] [--print]", key: "config", needs: ["tunnels:read"] },
    { usage: "exec <tunnel>… [--label …] [--group …] -- <cmd>", key: "exec", needs: ["ssh:exec"] },
    { usage: "cp <from> <to>", key: "cp", needs: ["ssh:files"] },
    { usage: "sessions [end <id>]", key: "sessions", needs: ["tunnels:read"] },
    { usage: "recordings ls | play <id>", key: "recordings", needs: ["ssh:exec"] },
    { usage: "snippets ls [--tunnel <t>]", key: "snippets", needs: ["ssh:exec"] },
    { usage: "run <snippet> <tunnel> [--var k=v]", key: "run", needs: ["ssh:exec"] },
    { usage: "browse <tunnel> [url] | ls | go | text | shot | click | type | close", key: "browse", needs: ["browser:use"] },
    { usage: "lan ls | add | rm <tunnel> …", key: "lan", needs: ["tunnels:read"] },
    { usage: "api tokens | activity [--follow]", key: "api", needs: [] },
    { usage: "doctor", key: "doctor", needs: [] },
];

/**
 * 彩蛋：`telepy dig` 不在 `--help` 裡（clap `hide = true`），總表也不列；只有在搜尋框打它的名字才現身。
 * The egg: `telepy dig` is hidden from `--help` and from the list; it only shows up when searched for by name.
 */
export const HIDDEN_COMMAND: CliCommand = { usage: "dig", key: "dig", needs: [] };

export function revealsHidden(query: string): boolean {
    return /^(telepy\s+)?dig$/i.test(query.trim());
}

/** 搜尋：指令與它的說明（已翻譯）都比對，不分大小寫；空字串 = 全部。/ Match the command and its translated text. */
export function filterCommands(commands: readonly CliCommand[], query: string, describe: (c: CliCommand) => string): CliCommand[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...commands];
    const words = q.split(/\s+/);
    return commands.filter((c) => {
        const hay = `${c.usage} ${describe(c)}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

// ---------------------------------------------------------------- environment

export interface CliEnvVar {
    name: string;
    key: string;
}

export const CLI_ENV: readonly CliEnvVar[] = [
    { name: "TELEPY_URL", key: "url" },
    { name: "TELEPY_TOKEN", key: "token" },
    { name: "TELEPY_NO_KEYRING", key: "noKeyring" },
    { name: "TELEPY_CONFIG_DIR", key: "configDir" },
    { name: "TELEPY_SSH_DIR", key: "sshDir" },
    { name: "TELEPY_NO_MASCOT", key: "noMascot" },
    { name: "NO_COLOR", key: "noColor" },
];

// ---------------------------------------------------------------- the getting-started steps

export type CliStartStep = "install" | "signIn" | "try";

export const CLI_START_STEPS: readonly CliStartStep[] = ["install", "signIn", "try"];

/**
 * 三步（安裝 → 登入 → 試試看）：看過 CLI 的登入（Connected apps 裡有 `telepy CLI (…)`）就表示裝好也登入了。
 * 用 token 登入的看不出來，所以登入那步不會因為有 token 就打勾。「試試看」沒辦法從這邊看出來，所以不會打勾。
 * 頁面打開在第一個沒打勾的那一步（`firstOpenStep`）。
 * The three steps (install → sign in → try it): a CLI sign-in under Connected apps means it is installed and
 * signed in. A token sign-in can't be told apart, so having tokens never ticks the sign-in step; "try it" can't be
 * seen from here, so it is never ticked. The page opens on the first unticked step (`firstOpenStep`).
 */
export function startSteps(cliSignIns: number): Record<CliStartStep, StepState> {
    const signed = cliSignIns > 0;
    return { install: signed ? "done" : "todo", signIn: signed ? "done" : "todo", try: "todo" };
}

// ---------------------------------------------------------------- what the terminal prints

/**
 * 終端機會印出的字，照 CLI 原樣（英文，CLI 不翻譯；跟程式碼一樣不進字典）。`cliGuide.test.ts` 比對 `src/cli` 的字串。
 * What the terminal prints, verbatim (English: the CLI is not translated; like code, not in the dictionaries).
 * The test checks these against the strings in `src/cli`.
 */
export interface OutputLine {
    text: string;
    tone?: "prompt" | "muted" | "ok";
}

export function signInSample(url: string, username: string, os: CliOs): OutputLine[] {
    const store = os === "linux" ? "config file" : "system keyring";
    return [
        { text: `telepy login ${url}`, tone: "prompt" },
        { text: "Opening Telepy in your browser to approve the CLI. If nothing opens, visit:", tone: "muted" },
        { text: `  ${url}/oauth/authorize?…`, tone: "muted" },
        { text: `Signed in to ${url} as ${username || "you"} (credentials in the ${store}).`, tone: "ok" },
    ];
}

export function doctorSample(url: string, username: string, os: CliOs): OutputLine[] {
    const store = os === "linux" ? "file" : "keyring";
    return [
        { text: "telepy doctor", tone: "prompt" },
        { text: `✓ server: ${url}` },
        { text: `✓ sign-in: ${username || "you"} (Oauth in the ${store})` },
        { text: `✓ scopes: ${LOGIN_SCOPES.join(" ")}` },
        { text: "✓ ssh: found" },
        { text: "✓ scp: found" },
        { text: "✓ sftp: found" },
        { text: `✓ ssh config dir: ${os === "windows" ? "C:\\Users\\you\\.ssh\\telepy" : "~/.ssh/telepy"}` },
        { text: "Everything looks good.", tone: "ok" },
    ];
}

// ---------------------------------------------------------------- the "how it works" diagram

/** 一條路的四站：你的終端機 ─ 憑證 ─ Telepy ─ 隧道 ─ 裝置。/ One lane: terminal ─ credential ─ Telepy ─ tunnel ─ device. */
export interface CliLane {
    you: SpotState;
    credential: SpotState;
    telepy: SpotState;
    tunnel: SpotState;
    device: SpotState;
}

/**
 * 兩條路的現況：大部分指令走 REST（要 CLI 登入過），ssh / scp / sftp 走系統的 OpenSSH（要個人 SSH 金鑰）。
 * 沒登入 = 等著；沒有金鑰 = ssh 那條斷在金鑰；金鑰數還不知道 = 等著。
 * Both lanes now: most commands go over REST (needs a CLI sign-in), ssh / scp / sftp through the system OpenSSH
 * (needs a personal SSH key). Not signed in = waiting; no key = the ssh lane fails at the key; unknown = waiting.
 */
export function cliLanes(signedIn: boolean, keyCount: number | null): { rest: CliLane; ssh: CliLane } {
    const through = (ok: boolean): CliLane => ({ you: "ok", credential: ok ? "ok" : "waiting", telepy: ok ? "ok" : "waiting", tunnel: ok ? "ok" : "waiting", device: ok ? "ok" : "waiting" });
    const ssh = keyCount === 0 ? { ...through(false), credential: "failed" as const } : through(keyCount !== null && keyCount > 0);
    return { rest: through(signedIn), ssh };
}
