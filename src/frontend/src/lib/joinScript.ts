/**
 * 一鍵加入腳本：給使用者的指令變體（貼進 shell / 先下載再檢查再執行 / 只預檢）、腳本在裝置上做的七步對應到票的階段
 * （畫流程圖用），以及腳本回報的環境（shell、SSH client / server、服務管理器、keepalive 模式）怎麼顯示。純函式，有測試。
 * The one-command join script: the command variants (pipe into sh / download, check, run / preflight only), the seven
 * steps the script does on the device mapped onto the ticket's phase (for the flow diagram), and how the facts it
 * reported (shell, SSH client / server, init, keepalive mode) are shown. Pure, tested.
 */
import type { TranslationKey } from "@/locales/en";

export type JoinPhase = "waiting" | "registered" | "connected" | "verified" | "failed";

/** 腳本回報的環境（後端 `join::parse_facts` 的白名單）。/ What the script found (the backend's allow-list). */
export interface JoinFacts {
    shell?: string;
    os?: string;
    arch?: string;
    http?: string;
    client?: string;
    server?: string;
    init?: string;
    keepalive?: string;
    key_format?: string;
    authorized_keys?: string;
    ssh_host?: string;
    transport?: string;
    /** 網頁 port 的小幫手：`binary <target>` / `python3` / `none`。/ The web-port helper: `binary <target>`, `python3` or `none`. */
    carrier?: string;
    compat?: string[];
}

export interface JoinCommands {
    /** `curl … | sh -s -- --token …`（後端給的那一行）。/ The pipe form (what the backend returns). */
    pipe: string;
    /** 先下載、`sh -n` 檢查語法、再執行：路由器 / 序列埠主控台貼上會掉字時用。/ Download, syntax-check, run. */
    download: string;
    /** 同上，沒有 curl 的 OpenWrt（wget = uclient-fetch）。/ The same with wget (stock OpenWrt). */
    wget: string;
    /** 不消耗 token 的預檢。/ The preflight, which uses no token. */
    check: string;
    checkWget: string;
}

/** 裝置怎麼連：自動（SSH port 優先，不通走網頁 port）/ 只走 SSH port / 只走網頁 port。/ How the device reaches Telepy. */
export type JoinTransport = "auto" | "ssh" | "websocket";

/** 每種方式加在指令後面的旗標。/ The flag each way adds to the command. */
export const TRANSPORT_FLAG: Record<JoinTransport, string> = { auto: " --auto", ssh: "", websocket: " --via-web" };

/** 指令變體；`sudo` = 以 sudo 執行（路由器上本來就是 root，不需要）。/ The command variants. */
export function joinCommands(installUrl: string, token: string, opts: { sudo: boolean; transport: JoinTransport }): JoinCommands {
    const flags = `--token ${token}${TRANSPORT_FLAG[opts.transport] ?? ""}`;
    const su = opts.sudo ? "sudo " : "";
    const file = "/tmp/telepy-join.sh";
    return {
        pipe: `curl -fsSL '${installUrl}' | ${su}sh -s -- ${flags}`,
        download: `curl -fsSL '${installUrl}' -o ${file} && sh -n ${file} && ${su}sh ${file} ${flags}`,
        wget: `wget -O ${file} '${installUrl}' && sh -n ${file} && ${su}sh ${file} ${flags}`,
        check: `curl -fsSL '${installUrl}' -o ${file} && ${su}sh ${file} --check`,
        checkWget: `wget -O ${file} '${installUrl}' && ${su}sh ${file} --check`,
    };
}

/** 腳本在裝置上的七步（圖上的順序）。/ The seven steps the script does on the device, in diagram order. */
export const SCRIPT_STEPS: TranslationKey[] = ["join.flow.s1", "join.flow.s2", "join.flow.s3", "join.flow.s4", "join.flow.s5", "join.flow.s6", "join.flow.s7"];

export interface ScriptProgress {
    /** 1-based；超過步數 = 全部做完。/ 1-based; past the last step = all done. */
    current: number;
    done: boolean;
    failed: boolean;
    now: TranslationKey;
}

/**
 * 票的階段 → 腳本走到哪一步。Telepy 只看得到註冊（第 4 步）、隧道連上（第 6 步跑起來了）與驗證；之前的步驟在裝置上
 * 進行、網頁看不到，所以 waiting 時第 1 步亮著、說明「在裝置上進行中」。失敗時：有隧道 = 卡在驗證，沒有 = 卡在註冊。
 * Ticket phase → where the script is. Telepy only sees registration (step 4), the tunnel coming up (step 6 running)
 * and the verification; the earlier steps happen on the device unseen, so while waiting step 1 is lit with a note.
 * Failed: with a tunnel the login check failed (step 7), without one the registration did.
 */
export function scriptProgress(phase: JoinPhase, hasTunnel: boolean, expired = false): ScriptProgress {
    switch (phase) {
        case "waiting":
            return { current: expired ? 0 : 1, done: false, failed: false, now: expired ? "join.flow.now.expired" : "join.flow.now.waiting" };
        case "registered":
            return { current: 5, done: false, failed: false, now: "join.flow.now.registered" };
        case "connected":
            return { current: 7, done: false, failed: false, now: "join.flow.now.connected" };
        case "verified":
            return { current: 8, done: true, failed: false, now: "join.flow.now.verified" };
        case "failed":
            return hasTunnel ? { current: 7, done: false, failed: true, now: "join.flow.now.failedLogin" } : { current: 4, done: false, failed: true, now: "join.flow.now.failedRegister" };
    }
}

export interface FactChip {
    key: "shell" | "client" | "server" | "init" | "keepalive" | "http" | "carrier";
    label: TranslationKey;
    value: string;
    /** 要翻譯的顯示文字（例如內建 client），沒有就照 `value`。/ Translated text to show instead of `value` (e.g. the built-in client). */
    text?: { key: TranslationKey; vars: Record<string, string> };
}

const CHIP_LABEL: Record<FactChip["key"], TranslationKey> = {
    shell: "join.facts.shell",
    client: "join.facts.client",
    server: "join.facts.server",
    init: "join.facts.init",
    keepalive: "join.facts.keepalive",
    http: "join.facts.http",
    carrier: "join.facts.carrier",
};

const INIT_NAME: Record<string, string> = { procd: "procd", systemd: "systemd", launchd: "launchd", loop: "reconnect loop" };

/** 顯示用的標籤（有值的才列）。/ The chips to show (only facts that were reported). */
export function factChips(facts: JoinFacts | null | undefined): FactChip[] {
    if (!facts) return [];
    const out: FactChip[] = [];
    const push = (key: FactChip["key"], value: string | undefined) => {
        if (value) out.push({ key, label: CHIP_LABEL[key], value });
    };
    push("client", facts.client);
    const builtin = builtinClient(facts.client);
    if (builtin !== undefined && out.length > 0) out[out.length - 1].text = { key: builtin ? "join.facts.clientBuiltinOf" : "join.facts.clientBuiltin", vars: { carrier: builtin } };
    push("server", facts.server);
    push("init", facts.init ? INIT_NAME[facts.init] ?? facts.init : undefined);
    push("shell", facts.shell);
    push("keepalive", facts.keepalive);
    push("carrier", carrierLabel(facts.carrier));
    return out;
}

/** 內建的 SSH client（`builtin (telepy-carrier 2.12.0 (x86_64-unknown-linux-musl, checksum verified))`）：括號裡的部分；
 *  不是內建的回 undefined。/ The built-in SSH client: what is in its parentheses ("" when nothing); undefined otherwise. */
export function builtinClient(client: string | undefined): string | undefined {
    if (!client || !/^builtin\b/.test(client)) return undefined;
    const inner = client.slice("builtin".length).trim();
    return inner.startsWith("(") && inner.endsWith(")") ? inner.slice(1, -1) : inner;
}

/** `binary x86_64-unknown-linux-musl` → `telepy-carrier (x86_64-unknown-linux-musl)`；`python3` 照樣；`none` / 空 = 不列。
 *  The chip text for the carrier fact; `none` or nothing = no chip. */
export function carrierLabel(carrier: string | undefined): string | undefined {
    if (!carrier || carrier === "none") return undefined;
    const target = carrier.match(/^binary\s+(\S+)/)?.[1];
    return target ? `telepy-carrier (${target})` : carrier;
}

/** 相容模式（SSH keepalive 關了、只靠 TCP keepalive）。/ The compat mode: SSH keepalives off, TCP keepalive only. */
export function compatNoServerAlive(facts: JoinFacts | null | undefined): boolean {
    return !!facts?.compat?.includes("no_server_alive");
}
