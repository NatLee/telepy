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
import type { SubcommandTree } from "./shellHighlight.ts";
import { CLI_EXAMPLES, CLI_EXAMPLE_TOPICS, type CliTopicId } from "./cliExamples.gen.ts";

export type { CliTopicId };

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

export { cliHost } from "./cliClient.ts";

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

/** 主題順序（`examples.rs` 的 `TOPICS`）。/ The topic order (`TOPICS` in examples.rs). */
export const CLI_TOPICS: readonly CliTopicId[] = CLI_EXAMPLE_TOPICS.map((t) => t.id);

/** 有開頭一句的主題（`cli.topic.<id>Intro`）。/ Topics with an opening sentence. */
export function topicIntro(topic: CliTopicId): TranslationKey | null {
    return CLI_EXAMPLE_TOPICS.find((t) => t.id === topic)?.intro ? (`cli.topic.${topic}Intro` as TranslationKey) : null;
}

export interface CliRecipe {
    id: string;
    /** `cli.ex.<id>`：標題；`cli.ex.<id>Note`：一句說明。/ The title and its one-line note. */
    title: TranslationKey;
    note: TranslationKey;
    command: Snippet;
    needs: CliNeed[];
    /** 範例裡還有佔位字（沒有真的隧道 / 標籤…）。/ The example still has a placeholder. */
    placeholder: boolean;
}

function sh(value: string): Snippet {
    return { language: "bash", value };
}

/**
 * 範例裡的佔位字換成這個人自己的（`shq` 包過，複製下來就能跑）；沒有的留著 `<…>`。片段有變數就在那行後面補 `--var`。
 * Fills an example's placeholders with the person's own (shell-quoted, so it runs as copied); missing ones stay
 * `<…>`. A snippet's variables become `--var` on its line.
 */
export function fillExample(lines: readonly string[], c: CliContext): string[] {
    const T = c.tunnel ? shq(c.tunnel) : null;
    const TA = c.tunnel ? (c.account ? shq(`${c.tunnel}@${c.account}`) : T) : null;
    const vars = (c.snippet?.vars ?? []).map((v) => ` --var ${shq(v)}=…`).join("");
    return lines.map((line) => {
        let out = line;
        if (TA) out = out.replaceAll(`${PLACEHOLDER.tunnel}@${PLACEHOLDER.account}`, TA);
        if (T) out = out.replaceAll(PLACEHOLDER.tunnel, T);
        if (c.other) out = out.replaceAll(PLACEHOLDER.other, shq(c.other));
        if (c.label) out = out.replaceAll(PLACEHOLDER.label, shq(c.label));
        if (c.group) out = out.replaceAll(PLACEHOLDER.group, shq(c.group));
        if (c.base) out = out.replaceAll("<url>", c.base);
        if (c.snippet && out.includes(PLACEHOLDER.snippet)) out = out.replaceAll(PLACEHOLDER.snippet, shq(c.snippet.name)) + vars;
        return out;
    });
}

const PLACEHOLDER_LEFT = /<[a-z0-9]+>/;

function recipe(id: string, lines: readonly string[], needs: readonly string[], c: CliContext): CliRecipe {
    const filled = fillExample(lines, c);
    return {
        id,
        title: `cli.ex.${id}` as TranslationKey,
        note: `cli.ex.${id}Note` as TranslationKey,
        command: sh(filled.join("\n")),
        needs: needs as CliNeed[],
        placeholder: filled.some((l) => PLACEHOLDER_LEFT.test(l)),
    };
}

/**
 * 一個主題的範例（`examples.rs` 那一份，填好這個人的名字）；「腳本與 CI」後面再加一個 GitHub Actions 的 job（檔案範本，不在 CLI 裡）。
 * A topic's examples (the ones in examples.rs, filled in); "Scripts & CI" adds a GitHub Actions job (a file template the CLI doesn't carry).
 */
export function cliRecipes(topic: CliTopicId, c: CliContext): CliRecipe[] {
    const out = CLI_EXAMPLES.filter((e) => e.topic === topic).map((e) => recipe(e.id, e.lines, e.needs, c));
    if (topic === "ci") {
        out.push({ ...recipe("ciActions", [], ["ssh:exec"], c), command: { language: "yaml", value: githubActions(c.base, c.label ? shq(c.label) : PLACEHOLDER.label) }, placeholder: !c.label });
    }
    return out;
}

/** 一行裡呼叫的 telepy 子指令（第一層）。/ The telepy subcommands a line calls (first level). */
export function invokedCommands(line: string): string[] {
    return [...line.matchAll(/(?:^|[\s(])telepy\s+([a-z][a-z-]*)/g)].map((m) => m[1]);
}

/** 用到某個指令的範例（指令表展開時看的）。/ The examples that use a command (the command list's expanded rows). */
export function examplesForCommand(key: string, c: CliContext): CliRecipe[] {
    return CLI_EXAMPLES.filter((e) => e.lines.some((l) => invokedCommands(l).includes(key))).map((e) => recipe(e.id, e.lines, e.needs, c));
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
    { usage: "ssh <tunnel>[@account] [-N] [-L …] [-R …] [-D …] [--via web|ssh] [-- cmd]", key: "ssh", needs: ["tunnels:read", "ssh-key"] },
    { usage: "scp [-r] <from>… <to>", key: "scp", needs: ["tunnels:read", "ssh-key"] },
    { usage: "sftp <tunnel>[@account]", key: "sftp", needs: ["tunnels:read", "ssh-key"] },
    { usage: "forward <tunnel>[@account] <host>[:port] [--local N] [--open]", key: "forward", needs: ["tunnels:read", "ssh-key"] },
    { usage: "config install [<tunnel>…|--all] [--print] | tidy [--check] [--yes] | fallback [ask|always|never]", key: "config", needs: ["tunnels:read"] },
    { usage: "exec <tunnel>… [--label …] [--group …] -- <cmd>", key: "exec", needs: ["ssh:exec"] },
    { usage: "cp <from> <to>", key: "cp", needs: ["ssh:files"] },
    { usage: "sessions [end <id>]", key: "sessions", needs: ["tunnels:read"] },
    { usage: "recordings ls | play <id>", key: "recordings", needs: ["ssh:exec"] },
    { usage: "snippets ls [--tunnel <t>]", key: "snippets", needs: ["ssh:exec"] },
    { usage: "run <snippet> <tunnel> [--var k=v]", key: "run", needs: ["ssh:exec"] },
    { usage: "browse <tunnel> [url] | ls | go | text | shot | click | type | close", key: "browse", needs: ["browser:use"] },
    { usage: "lan ls | map | scan | check | schedule | watch | wake | os | show | add | edit | rm <tunnel> …", key: "lan", needs: ["tunnels:read"] },
    { usage: "api tokens | activity [--follow]", key: "api", needs: [] },
    { usage: "keys [ls] | add [<file>] [--device <tunnel>] | check <tunnel>[@account] [--yes]", key: "keys", needs: [] },
    { usage: "doctor", key: "doctor", needs: [] },
    { usage: "update [--check] [--to <version>]", key: "update", needs: [] },
    { usage: "completions [bash|zsh|fish|powershell|elvish]", key: "completions", needs: [] },
    { usage: "examples [<topic>|<command>]", key: "examples", needs: [] },
];

/**
 * 子指令樹（上色用）：從總表的用法讀出來——`lan ls | map | …` 的第二層是每段的第一個字。
 * The subcommand tree for highlighting, read from the list's usages: `lan ls | map | …` → the first word of each part.
 */
export const CLI_SUBCOMMANDS: SubcommandTree = Object.fromEntries(
    CLI_COMMANDS.map((c) => {
        const parts = c.usage.split(" | ");
        const words = parts.map((p, i) => (i === 0 ? p.split(" ")[1] ?? "" : p.split(" ")[0])).map((w) => w.replace(/^\[|\]$/g, ""));
        return [c.key, words.filter((w) => /^[a-z]+$/.test(w))];
    })
);

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
    { name: "TELEPY_SSH_VIA", key: "sshVia" },
    { name: "TELEPY_SSH_FALLBACK", key: "sshFallback" },
    { name: "TELEPY_NO_KEY_CHECK", key: "noKeyCheck" },
    { name: "TELEPY_NO_MASCOT", key: "noMascot" },
    { name: "TELEPY_NO_UPDATE_CHECK", key: "noUpdateCheck" },
    { name: "TELEPY_RELEASES_URL", key: "releasesUrl" },
    { name: "NO_COLOR", key: "noColor" },
    { name: "CLICOLOR_FORCE", key: "clicolorForce" },
];

// ---------------------------------------------------------------- Tab completion

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell" | "elvish";

export interface CompletionSetup {
    shell: CompletionShell;
    /** 設定檔（照 CLI 印的原樣）。/ The startup file, as the CLI prints it. */
    file: string;
    /** 要加進去的那一行。/ The line to add. */
    line: string;
}

/**
 * `telepy completions` 印的設定：跟 `src/cli/src/complete.rs` 的 `SETUP` 一字不差（測試比對）。
 * bash 用 `eval "$(…)"` 而不是 `source <(…)`：macOS 內建的 bash 3.2 讀不到後者。
 * What `telepy completions` prints, identical to `SETUP` in `src/cli/src/complete.rs` (the test compares them).
 * bash gets `eval "$(…)"` rather than `source <(…)`, which macOS's bash 3.2 silently ignores.
 */
export const COMPLETION_SETUP: readonly CompletionSetup[] = [
    { shell: "bash", file: "~/.bashrc (macOS: ~/.bash_profile)", line: 'eval "$(telepy completions bash)"' },
    { shell: "zsh", file: "~/.zshrc", line: 'eval "$(telepy completions zsh)"' },
    { shell: "fish", file: "~/.config/fish/config.fish", line: "telepy completions fish | source" },
    { shell: "powershell", file: "$PROFILE", line: "telepy completions powershell | Out-String | Invoke-Expression" },
    { shell: "elvish", file: "~/.config/elvish/rc.elv", line: "eval (telepy completions elvish | slurp)" },
];

/** 每個系統預設的 shell：macOS = zsh（10.15 起）、Linux = bash、Windows = PowerShell。/ Each system's default shell. */
export function defaultShell(os: CliOs): CompletionShell {
    return os === "macos" ? "zsh" : os === "windows" ? "powershell" : "bash";
}

// ---------------------------------------------------------------- the getting-started steps

export type CliStartStep = "install" | "signIn" | "try";

export const CLI_START_STEPS: readonly CliStartStep[] = ["install", "signIn", "try"];

/**
 * 三步（安裝 → 登入 → 試試看）：看過 CLI 的登入（API 頁「CLI 登入」裡有 `telepy CLI (…)`）就表示裝好也登入了。
 * 用 token 登入的看不出來，所以登入那步不會因為有 token 就打勾。「試試看」沒辦法從這邊看出來，所以不會打勾。
 * 頁面打開在第一個沒打勾的那一步（`firstOpenStep`）。
 * The three steps (install → sign in → try it): a CLI sign-in (the API page's CLI sign-ins) means it is installed and
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
