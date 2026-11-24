/**
 * 「這些工具差在哪」（純資料 + 純函式）：功能重疊的幾組 telepy 指令——連到埠與網路（forward / ssh / proxy / vpn）、
 * 搬檔案（cp / scp / rsync / sftp）、執行指令（ssh / exec / run）——每個工具做得到哪幾件事、各自需要什麼。
 * 誰包含誰、誰跟誰一樣、哪件事只有一個工具做得到，都是從這張表算出來的，不另外手寫（寫兩份就會不一致）。
 * 事實的出處是 docs/cli.md 與 docs/proxy.md：改這裡之前先對過那兩份。
 * "How these tools differ" (pure data + functions): the telepy commands that overlap — reaching ports and networks
 * (forward / ssh / proxy / vpn), moving files (cp / scp / rsync / sftp), running commands (ssh / exec / run) — what
 * each can do and what each needs. Which tool contains which, which are equal and what only one tool does are all
 * computed from this table, never written a second time. The facts come from docs/cli.md and docs/proxy.md.
 */
import type { TranslationKey } from "../locales/en.ts";

export type FamilyId = "reach" | "files" | "run";
/** 工具需要什麼：你的 SSH 金鑰在裝置上、Telepy 的登入（或 token）、這台電腦的管理員權限。/ What a tool needs. */
export type Need = "key" | "signin" | "admin";

export interface OverlapTool {
    id: string;
    /** 指令本身（產品名與旗標，不翻譯）。/ The command itself (never translated). */
    name: string;
    needs: Need[];
    /** 被別的工具完全涵蓋、需要的東西又一樣時：它還存在的理由（一句話）。/ Why it still exists when another tool covers it and needs the same. */
    note?: TranslationKey;
    /** 做得到的事 → 用哪個旗標做（沒有特別的旗標就是空字串）。/ What it can do → the flag that does it ("" when none in particular). */
    can: Record<string, string>;
}

export interface OverlapFamily {
    id: FamilyId;
    /** 這組的每件事，由小到大。/ Everything in this family, small to large. */
    caps: string[];
    tools: OverlapTool[];
}

export const FAMILIES: OverlapFamily[] = [
    {
        id: "reach",
        caps: ["localOnly", "lanPort", "anyAddress", "noProxySetting", "realAddress", "allTraffic", "pingUdp", "reverse"],
        tools: [
            { id: "forward", name: "telepy forward", needs: ["key"], note: "sheet.overlap.reach.forwardNote", can: { localOnly: "", lanPort: "", noProxySetting: "" } },
            { id: "ssh", name: "telepy ssh", needs: ["key"], can: { localOnly: "-L", lanPort: "-L", anyAddress: "-D", noProxySetting: "-L", reverse: "-R" } },
            { id: "proxy", name: "telepy proxy", needs: ["signin"], can: { localOnly: "", lanPort: "", anyAddress: "" } },
            { id: "vpn", name: "telepy vpn", needs: ["key", "admin"], can: { lanPort: "", anyAddress: "", noProxySetting: "", realAddress: "", allTraffic: "--all", pingUdp: "--carrier" } },
        ],
    },
    {
        id: "files",
        caps: ["copyFile", "noKey", "behindDevice", "wholeFolder", "onlyChanges", "interactive"],
        tools: [
            { id: "cp", name: "telepy cp", needs: ["signin"], can: { copyFile: "", noKey: "", behindDevice: "" } },
            { id: "scp", name: "telepy scp", needs: ["key"], note: "sheet.overlap.files.scpNote", can: { copyFile: "", wholeFolder: "-r" } },
            { id: "rsync", name: "telepy rsync", needs: ["key"], can: { copyFile: "", wholeFolder: "-a", onlyChanges: "" } },
            { id: "sftp", name: "telepy sftp", needs: ["key"], can: { copyFile: "", wholeFolder: "-r", interactive: "" } },
        ],
    },
    {
        id: "run",
        caps: ["oneCommand", "shell", "manyDevices", "rules", "noKeyRun", "saved"],
        tools: [
            { id: "ssh", name: "telepy ssh", needs: ["key"], can: { oneCommand: "", shell: "" } },
            { id: "exec", name: "telepy exec", needs: ["signin"], can: { oneCommand: "", manyDevices: "--label", rules: "", noKeyRun: "" } },
            { id: "run", name: "telepy run", needs: ["signin"], can: { oneCommand: "", rules: "", noKeyRun: "", saved: "" } },
        ],
    },
];

export const family = (id: FamilyId): OverlapFamily => FAMILIES.find((f) => f.id === id)!;

export const capLabel = (f: FamilyId, cap: string): TranslationKey => `sheet.overlap.${f}.${cap}` as TranslationKey;

const caps = (t: OverlapTool): string[] => Object.keys(t.can);
const within = (a: OverlapTool, b: OverlapTool): boolean => caps(a).every((c) => c in b.can);

export interface Containment {
    tool: OverlapTool;
    /** 它做得到的事別的工具全都做得到：那些被它包含的工具。/ The tools it fully covers (everything they do, it does too). */
    covers: OverlapTool[];
    /** 一模一樣的工具（做得到的事完全相同）。/ Tools that do exactly the same things. */
    same: OverlapTool[];
    /** 比被它包含的工具多出來的事（沒有包含誰時 = 它全部的事）。/ What it adds over the tools it covers (all of it when it covers none). */
    adds: string[];
    /** 這一組裡只有它做得到的事。/ What only this tool in the family does. */
    only: string[];
}

/** 每個工具跟同組其他工具的關係，照 `tools` 的順序。/ Each tool's relation to the others of its family, in `tools` order. */
export function containment(f: OverlapFamily): Containment[] {
    return f.tools.map((tool) => {
        const others = f.tools.filter((o) => o !== tool);
        const same = others.filter((o) => within(o, tool) && within(tool, o));
        const covers = others.filter((o) => within(o, tool) && !within(tool, o));
        const covered = new Set(covers.flatMap(caps));
        return {
            tool,
            covers,
            same,
            adds: f.caps.filter((c) => c in tool.can && !covered.has(c)),
            only: f.caps.filter((c) => c in tool.can && others.every((o) => !(c in o.can))),
        };
    });
}

/** 需要的東西是不是一樣（順序無關）。/ Whether two tools need the same things. */
export const sameNeeds = (a: OverlapTool, b: OverlapTool): boolean => a.needs.length === b.needs.length && a.needs.every((n) => b.needs.includes(n));

/** 每個工具都做得到的事。/ What every tool of the family can do. */
export function shared(f: OverlapFamily): string[] {
    return f.caps.filter((c) => f.tools.every((t) => c in t.can));
}

/** 速查頁的任務屬於哪一組（沒有重疊工具的任務不在這裡）。/ The family a sheet task belongs to (tasks without overlapping tools are absent). */
export const TASK_FAMILY: Partial<Record<string, FamilyId>> = { local: "reach", lan: "reach", socks: "reach", remote: "reach", vpn: "reach", copy: "files" };
/** CLI 主題屬於哪一組。/ The family of a CLI topic. */
export const TOPIC_FAMILY: Partial<Record<string, FamilyId>> = { forward: "reach", files: "files", many: "run", toolbox: "run" };
