/**
 * 指令速查的指令產生器（純函式，無 React）。每個情境把參數組成「片段」：片段 = 幾個 token + 一段說明 key，
 * 所以同一份資料可以同時拿來複製（純文字）、上色顯示、滑過看說明、以及列出「每一段是什麼意思」。
 * Command builder for the command sheet (pure, no React). Each recipe turns its parameters into *segments* —
 * a few tokens plus an explanation key — so one structure drives the copyable text, the coloured display, the
 * hover tooltips and the "what each part means" legend.
 *
 * 連線路徑：你的電腦 →(SSH)→ Telepy gateway →(反向隧道)→ 裝置 sshd。gateway 只允許 direct-tcpip 到
 * localhost:<reverse_port>，所以所有轉發（-L / -R / -D）都是建立在「SSH 到裝置本身」這條連線上。
 * Path: your computer →(SSH)→ Telepy gateway →(reverse tunnel)→ the device's sshd. The gateway only allows
 * direct-tcpip to localhost:<reverse_port>, so every forward (-L / -R / -D) rides an SSH session to the device.
 */
import type { TranslationKey } from "@/locales/en";

export type RecipeId = "local" | "lan" | "socks" | "remote" | "jump" | "copy";

/** alias：用 ~/.ssh/config 的 Host 別名；direct：不需要 config 的單行指令（-J 經 Telepy）。 */
export type ConnectMode = "alias" | "direct";

export interface ConnectTarget {
    /** ~/.ssh/config 裡裝置的 Host 別名（後端 sanitize 過）。/ The device's Host alias in ~/.ssh/config. */
    alias: string;
    /** 裝置上的 OS 使用者（目標主機使用者）。/ OS user on the device (target server user). */
    username: string;
    /** Telepy 伺服器主機名稱。/ Telepy server hostname. */
    serverHost: string;
    /** REVERSE_SERVER_SSH_PORT；空字串 = 22。/ The gateway's SSH port; "" means 22. */
    serverPort: string;
    /** 這條隧道在伺服器上的反向埠。/ This tunnel's reverse port on the server. */
    reversePort: number;
    mode: ConnectMode;
}

export interface ForwardOptions {
    background: boolean;
    keepAlive: boolean;
    exitOnFailure: boolean;
}

export type TokenKind = "cmd" | "flag" | "value" | "target" | "arg";

export interface Token {
    text: string;
    kind: TokenKind;
}

export interface Explain {
    key: TranslationKey;
    vars?: Record<string, string | number>;
}

export interface Segment {
    tokens: Token[];
    explain?: Explain;
}

export type RecipeParams = Record<string, string>;

export interface FieldDef {
    key: string;
    label: TranslationKey;
    kind: "port" | "text" | "choice";
    choices?: { value: string; label: TranslationKey }[];
}

export interface RecipeDef {
    id: RecipeId;
    /** 情境卡片上的旗標徽章（-L / -D …）。/ Flag badge shown on the recipe tile. */
    flag: string;
    title: TranslationKey;
    fields: FieldDef[];
    defaults: RecipeParams;
    /** 是否為長駐轉發（可加 -f / keep-alive 等選項）。/ Long-running forward that accepts -f / keep-alive options. */
    forwarding: boolean;
}

export const RECIPES: RecipeDef[] = [
    {
        id: "local",
        flag: "-L",
        title: "sheet.recipe.local.title",
        fields: [
            { key: "remotePort", label: "sheet.field.devicePort", kind: "port" },
            { key: "localPort", label: "sheet.field.localPort", kind: "port" },
        ],
        defaults: { remotePort: "80", localPort: "8080" },
        forwarding: true,
    },
    {
        id: "lan",
        flag: "-L",
        title: "sheet.recipe.lan.title",
        fields: [
            { key: "lanHost", label: "sheet.field.lanHost", kind: "text" },
            { key: "lanPort", label: "sheet.field.lanPort", kind: "port" },
            { key: "localPort", label: "sheet.field.localPort", kind: "port" },
        ],
        defaults: { lanHost: "192.168.1.1", lanPort: "443", localPort: "8443" },
        forwarding: true,
    },
    {
        id: "socks",
        flag: "-D",
        title: "sheet.recipe.socks.title",
        fields: [{ key: "localPort", label: "sheet.field.proxyPort", kind: "port" }],
        defaults: { localPort: "1080" },
        forwarding: true,
    },
    {
        id: "remote",
        flag: "-R",
        title: "sheet.recipe.remote.title",
        fields: [
            { key: "localPort", label: "sheet.field.yourServicePort", kind: "port" },
            { key: "devicePort", label: "sheet.field.deviceListenPort", kind: "port" },
        ],
        defaults: { localPort: "3000", devicePort: "9000" },
        forwarding: true,
    },
    {
        id: "jump",
        flag: "-J",
        title: "sheet.recipe.jump.title",
        fields: [
            { key: "lanUser", label: "sheet.field.lanUser", kind: "text" },
            { key: "lanHost", label: "sheet.field.lanHost", kind: "text" },
            { key: "lanPort", label: "sheet.field.lanSshPort", kind: "port" },
        ],
        defaults: { lanUser: "ubuntu", lanHost: "192.168.1.20", lanPort: "22" },
        forwarding: false,
    },
    {
        id: "copy",
        flag: "scp",
        title: "sheet.recipe.copy.title",
        fields: [
            {
                key: "direction",
                label: "sheet.field.direction",
                kind: "choice",
                choices: [
                    { value: "upload", label: "sheet.field.upload" },
                    { value: "download", label: "sheet.field.download" },
                ],
            },
            {
                key: "tool",
                label: "sheet.field.tool",
                kind: "choice",
                choices: [
                    { value: "scp", label: "sheet.field.toolScp" },
                    { value: "rsync", label: "sheet.field.toolRsync" },
                ],
            },
            { key: "localPath", label: "sheet.field.localPath", kind: "text" },
            { key: "remotePath", label: "sheet.field.remotePath", kind: "text" },
        ],
        defaults: { direction: "upload", tool: "scp", localPath: "./project", remotePath: "~/" },
        forwarding: false,
    },
];

export const RECIPE_BY_ID: Record<RecipeId, RecipeDef> = Object.fromEntries(RECIPES.map((r) => [r.id, r])) as Record<RecipeId, RecipeDef>;

/** -L 常用服務預設（裝置埠 → 本機埠；本機避開需要管理員權限的 <1024）。/ Common -L presets (device → local port). */
export const LOCAL_PRESETS: { label: string; remotePort: string; localPort: string }[] = [
    { label: "HTTP", remotePort: "80", localPort: "8080" },
    { label: "HTTPS", remotePort: "443", localPort: "8443" },
    { label: "Dev 3000", remotePort: "3000", localPort: "3000" },
    { label: "Jupyter", remotePort: "8888", localPort: "8888" },
    { label: "PostgreSQL", remotePort: "5432", localPort: "15432" },
    { label: "MySQL", remotePort: "3306", localPort: "13306" },
    { label: "Redis", remotePort: "6379", localPort: "16379" },
    { label: "RDP", remotePort: "3389", localPort: "13389" },
    { label: "VNC", remotePort: "5900", localPort: "15900" },
];

export function isValidPort(value: string): boolean {
    if (!/^\d{1,5}$/.test(value)) return false;
    const n = Number(value);
    return n >= 1 && n <= 65535;
}

export function isValidHost(value: string): boolean {
    return /^[A-Za-z0-9._:\[\]-]+$/.test(value);
}

/** 非法 / 空值時退回預設，指令永遠可以跑。/ Fall back to the default so the command always stays runnable. */
function port(params: RecipeParams, key: string, def: RecipeDef): string {
    const v = (params[key] ?? "").trim();
    return isValidPort(v) ? v : def.defaults[key];
}

function host(params: RecipeParams, key: string, def: RecipeDef): string {
    const v = (params[key] ?? "").trim();
    return v && isValidHost(v) ? v : def.defaults[key];
}

function text(params: RecipeParams, key: string, def: RecipeDef): string {
    const v = (params[key] ?? "").trim();
    return v || def.defaults[key];
}

/**
 * 把表單值換成「實際會用到的值」（非法 / 空值退回預設），流程圖與說明文字跟指令用同一套值。
 * Resolve form values to what the command actually uses (invalid / empty → default), so the diagram and hints match.
 */
export function resolveParams(id: RecipeId, params: RecipeParams): RecipeParams {
    const def = RECIPE_BY_ID[id];
    const out: RecipeParams = { ...def.defaults };
    for (const f of def.fields) {
        if (f.kind === "port") out[f.key] = port(params, f.key, def);
        else if (f.kind === "choice") out[f.key] = f.choices?.some((c) => c.value === params[f.key]) ? params[f.key] : def.defaults[f.key];
        else if (f.key === "lanHost") out[f.key] = host(params, f.key, def);
        else out[f.key] = text(params, f.key, def);
    }
    return out;
}

/** POSIX shell 引號：安全字元原樣輸出，其他用單引號包起來。/ POSIX quoting: safe words as-is, others single-quoted. */
export function shq(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const tok = (text: string, kind: TokenKind): Token => ({ text, kind });

/** `telepy@host[:port]`：-J 的 Telepy 伺服器跳板。/ The Telepy server as a -J hop. */
export function jumpServerSpec(target: ConnectTarget): string {
    return target.serverPort && target.serverPort !== "22"
        ? `telepy@${target.serverHost}:${target.serverPort}`
        : `telepy@${target.serverHost}`;
}

/** 連到裝置本身的目標片段（別名，或 -J … -p … user@localhost）。/ Segments that address the device itself. */
function deviceTarget(target: ConnectTarget): Segment[] {
    if (target.mode === "alias") {
        return [{ tokens: [tok(target.alias, "target")], explain: { key: "sheet.explain.alias", vars: { alias: target.alias, user: target.username } } }];
    }
    return [
        { tokens: [tok("-J", "flag"), tok(jumpServerSpec(target), "value")], explain: { key: "sheet.explain.jumpServer" } },
        {
            tokens: [tok("-p", "flag"), tok(String(target.reversePort), "value"), tok(`${target.username}@localhost`, "target")],
            explain: { key: "sheet.explain.directTarget", vars: { port: target.reversePort, user: target.username } },
        },
    ];
}

function forwardOptionSegments(options: ForwardOptions): Segment[] {
    const out: Segment[] = [{ tokens: [tok("-N", "flag")], explain: { key: "sheet.explain.noShell" } }];
    if (options.background) out.push({ tokens: [tok("-f", "flag")], explain: { key: "sheet.explain.background" } });
    if (options.keepAlive) out.push({ tokens: [tok("-o", "flag"), tok("ServerAliveInterval=30", "value")], explain: { key: "sheet.explain.keepAlive" } });
    if (options.exitOnFailure) out.push({ tokens: [tok("-o", "flag"), tok("ExitOnForwardFailure=yes", "value")], explain: { key: "sheet.explain.exitOnFailure" } });
    return out;
}

const SSH: Segment = { tokens: [tok("ssh", "cmd")], explain: { key: "sheet.explain.ssh" } };

/**
 * 轉發規格（-L / -R / -D 的參數）；背景執行時拿來給 `pkill -f` 比對。
 * The forward spec (the -L / -R / -D argument); also the `pkill -f` pattern for background runs.
 */
export function forwardSpec(id: RecipeId, params: RecipeParams): string | null {
    const def = RECIPE_BY_ID[id];
    switch (id) {
        case "local":
            return `${port(params, "localPort", def)}:localhost:${port(params, "remotePort", def)}`;
        case "lan":
            return `${port(params, "localPort", def)}:${host(params, "lanHost", def)}:${port(params, "lanPort", def)}`;
        case "socks":
            return `-D ${port(params, "localPort", def)}`;
        case "remote":
            return `${port(params, "devicePort", def)}:localhost:${port(params, "localPort", def)}`;
        default:
            return null;
    }
}

export function buildSegments(id: RecipeId, params: RecipeParams, target: ConnectTarget, options: ForwardOptions): Segment[] {
    const def = RECIPE_BY_ID[id];
    switch (id) {
        case "local": {
            const lp = port(params, "localPort", def);
            const rp = port(params, "remotePort", def);
            return [
                SSH,
                ...forwardOptionSegments(options),
                { tokens: [tok("-L", "flag"), tok(`${lp}:localhost:${rp}`, "value")], explain: { key: "sheet.explain.localForward", vars: { localPort: lp, host: "localhost", remotePort: rp } } },
                ...deviceTarget(target),
            ];
        }
        case "lan": {
            const lp = port(params, "localPort", def);
            const h = host(params, "lanHost", def);
            const rp = port(params, "lanPort", def);
            return [
                SSH,
                ...forwardOptionSegments(options),
                { tokens: [tok("-L", "flag"), tok(`${lp}:${h}:${rp}`, "value")], explain: { key: "sheet.explain.localForward", vars: { localPort: lp, host: h, remotePort: rp } } },
                ...deviceTarget(target),
            ];
        }
        case "socks": {
            const lp = port(params, "localPort", def);
            return [
                SSH,
                ...forwardOptionSegments(options),
                { tokens: [tok("-D", "flag"), tok(lp, "value")], explain: { key: "sheet.explain.dynamicForward", vars: { port: lp } } },
                ...deviceTarget(target),
            ];
        }
        case "remote": {
            const lp = port(params, "localPort", def);
            const dp = port(params, "devicePort", def);
            return [
                SSH,
                ...forwardOptionSegments(options),
                { tokens: [tok("-R", "flag"), tok(`${dp}:localhost:${lp}`, "value")], explain: { key: "sheet.explain.remoteForward", vars: { devicePort: dp, localPort: lp } } },
                ...deviceTarget(target),
            ];
        }
        case "jump": {
            const user = text(params, "lanUser", def);
            const h = host(params, "lanHost", def);
            const p = port(params, "lanPort", def);
            const hop: Segment = target.mode === "alias"
                ? { tokens: [tok("-J", "flag"), tok(target.alias, "value")], explain: { key: "sheet.explain.jumpDevice", vars: { alias: target.alias } } }
                : {
                    tokens: [tok("-J", "flag"), tok(`${jumpServerSpec(target)},${target.username}@localhost:${target.reversePort}`, "value")],
                    explain: { key: "sheet.explain.jumpChain", vars: { user: target.username } },
                };
            const out: Segment[] = [SSH, hop];
            if (p !== "22") out.push({ tokens: [tok("-p", "flag"), tok(p, "value")], explain: { key: "sheet.explain.lanPort", vars: { port: p } } });
            out.push({ tokens: [tok(`${shq(user)}@${h}`, "target")], explain: { key: "sheet.explain.lanTarget", vars: { user, host: h } } });
            return out;
        }
        case "copy": {
            const upload = (params.direction ?? def.defaults.direction) !== "download";
            const rsync = (params.tool ?? def.defaults.tool) === "rsync";
            const localPath = text(params, "localPath", def);
            const remotePath = text(params, "remotePath", def);
            const remoteHost = target.mode === "alias" ? target.alias : `${target.username}@localhost`;
            const local: Segment = { tokens: [tok(shq(localPath), "arg")], explain: { key: upload ? "sheet.explain.copyFromLocal" : "sheet.explain.copyToLocal", vars: { path: localPath } } };
            const remote: Segment = { tokens: [tok(`${remoteHost}:${shq(remotePath)}`, "target")], explain: { key: upload ? "sheet.explain.copyToDevice" : "sheet.explain.copyFromDevice", vars: { path: remotePath } } };
            const [src, dst] = upload ? [local, remote] : [remote, local];
            if (rsync) {
                const out: Segment[] = [{ tokens: [tok("rsync", "cmd"), tok("-avz", "flag"), tok("--progress", "flag")], explain: { key: "sheet.explain.rsync" } }];
                if (target.mode === "direct") {
                    out.push({
                        tokens: [tok("-e", "flag"), tok(`"ssh -J ${jumpServerSpec(target)} -p ${target.reversePort}"`, "value")],
                        explain: { key: "sheet.explain.rsyncShell", vars: { port: target.reversePort } },
                    });
                }
                return [...out, src, dst];
            }
            const out: Segment[] = [{ tokens: [tok("scp", "cmd"), tok("-r", "flag")], explain: { key: "sheet.explain.scp" } }];
            if (target.mode === "direct") {
                out.push({ tokens: [tok("-J", "flag"), tok(jumpServerSpec(target), "value")], explain: { key: "sheet.explain.jumpServer" } });
                out.push({ tokens: [tok("-P", "flag"), tok(String(target.reversePort), "value")], explain: { key: "sheet.explain.scpPort", vars: { port: target.reversePort } } });
            }
            return [...out, src, dst];
        }
    }
}

/**
 * 每段長說明對應的「短標籤」：註解式指令（像 explainshell）在每段底下只放幾個字，長說明留給 hover。
 * Short label for each long explanation: the annotated command (explainshell-style) shows a few words under
 * every part and keeps the long sentence for hover.
 */
export const SHORT_LABEL: Partial<Record<TranslationKey, TranslationKey>> = {
    "sheet.explain.ssh": "sheet.part.ssh",
    "sheet.explain.noShell": "sheet.part.noShell",
    "sheet.explain.background": "sheet.part.background",
    "sheet.explain.keepAlive": "sheet.part.keepAlive",
    "sheet.explain.exitOnFailure": "sheet.part.exitOnFailure",
    "sheet.explain.localForward": "sheet.part.localForward",
    "sheet.explain.dynamicForward": "sheet.part.dynamicForward",
    "sheet.explain.remoteForward": "sheet.part.remoteForward",
    "sheet.explain.alias": "sheet.part.alias",
    "sheet.explain.jumpServer": "sheet.part.jumpServer",
    "sheet.explain.directTarget": "sheet.part.directTarget",
    "sheet.explain.jumpDevice": "sheet.part.jumpDevice",
    "sheet.explain.jumpChain": "sheet.part.jumpChain",
    "sheet.explain.lanPort": "sheet.part.lanPort",
    "sheet.explain.lanTarget": "sheet.part.lanTarget",
    "sheet.explain.scp": "sheet.part.scp",
    "sheet.explain.scpPort": "sheet.part.scpPort",
    "sheet.explain.rsync": "sheet.part.rsync",
    "sheet.explain.rsyncShell": "sheet.part.rsyncShell",
    "sheet.explain.copyFromLocal": "sheet.part.copyFromLocal",
    "sheet.explain.copyToLocal": "sheet.part.copyToLocal",
    "sheet.explain.copyToDevice": "sheet.part.copyToDevice",
    "sheet.explain.copyFromDevice": "sheet.part.copyFromDevice",
    "sheet.explain.remoteCommand": "sheet.part.remoteCommand",
};

export function segmentsToString(segments: Segment[]): string {
    return segments.flatMap((s) => s.tokens.map((t) => t.text)).join(" ");
}

/** 開 shell / 執行單一指令（速查表的額外兩列）。/ Open a shell / run one command (extra quick-reference rows). */
export function shellSegments(target: ConnectTarget, command?: string): Segment[] {
    const out: Segment[] = [SSH, ...deviceTarget(target)];
    if (command) out.push({ tokens: [tok(shq(command), "arg")], explain: { key: "sheet.explain.remoteCommand" } });
    return out;
}
