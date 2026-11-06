"use client";

/**
 * 三種埠轉發往哪個方向：-L（`telepy forward`）＝你在這裡開本機埠、裝置接到後面的主機；-R ＝裝置那邊開埠、連回你的電腦；
 * -D ＝瀏覽器把裝置當 SOCKS 代理。箭頭 = 連線的方向，「從這裡開始」= 誰先連。直線、直角；容器窄時改成直排。
 * CLI 頁的埠轉發主題與指令速查都用它；`active` 標出正在看的那種，`values` 換成實際的埠。
 * Which way the three kinds of port forwarding go: -L (`telepy forward`) = you open a local port here and the device
 * connects on to the host; -R = a port opened on the device comes back to your computer; -D = the browser uses the
 * device as its SOCKS proxy. Arrows = the connection's direction, "starts here" = who connects first. Straight lines;
 * a column when the container is narrow. Used by the CLI page's forwarding topic and the command sheet; `active`
 * marks the kind being looked at, `values` puts in the real ports.
 */
import React from "react";
import { ArrowLeft, ArrowRight, Cpu, Globe, Laptop, Server } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ForwardKind = "local" | "remote" | "socks";

export interface ForwardValues {
    local: { local: string; host: string; port: string };
    remote: { remote: string; local: string };
    socks: { local: string };
}

/** 跟 CLI 範例（`examples.rs` 的 forward / forwardRemote / forwardSocks）同一組數字。/ The same numbers as the CLI examples. */
export const EXAMPLE_FORWARD_VALUES: ForwardValues = {
    local: { local: "8080", host: "localhost", port: "80" },
    remote: { remote: "9000", local: "3000" },
    socks: { local: "1080" },
};

const FLAG: Record<ForwardKind, string> = { local: "-L", remote: "-R", socks: "-D" };
const VIA: Record<ForwardKind, string> = { local: "telepy forward · telepy ssh -L", remote: "telepy ssh -R", socks: "telepy ssh -D" };

function Node({ icon: Icon, label, port, starts }: { icon: typeof Laptop; label: string; port?: string; starts?: boolean }) {
    const { t } = useI18n();
    return (
        <span className="flex min-w-0 shrink-0 flex-col items-center gap-0.5 self-center">
            <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-sm text-foreground", starts ? "border-foreground/35" : "border-border")}>
                <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
                {port && <span className="shrink-0 font-mono text-xs text-muted-foreground">{port}</span>}
            </span>
            {starts && <span className="text-xs text-muted-foreground">{t("fwdKinds.starts")}</span>}
        </span>
    );
}

/** 一段線與箭頭：橫排時是橫線，直排時轉成往下（往左的就往上）。/ A line with its arrow; turns downwards (or up) in a column. */
function Link({ back = false, tunnel = false }: { back?: boolean; tunnel?: boolean }) {
    const Arrow = back ? ArrowLeft : ArrowRight;
    return (
        <span className="flex min-w-6 shrink-0 items-center justify-center self-center py-0.5 text-muted-foreground @lg:flex-1 @lg:py-0">
            {back && <Arrow size={14} className="shrink-0 rotate-90 @lg:rotate-0" aria-hidden />}
            <span className={cn("hidden min-w-3 flex-1 @lg:block", tunnel ? "h-[5px] border-y border-muted-foreground/60" : "h-px bg-muted-foreground/60")} />
            {!back && <Arrow size={14} className="shrink-0 rotate-90 @lg:rotate-0" aria-hidden />}
        </span>
    );
}

function Telepy() {
    return (
        <span className="inline-flex shrink-0 items-center gap-1 self-center rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-foreground">
            <span className="grid size-4 place-items-center rounded bg-brand-gradient" aria-hidden>
                <TelepyGlyph size={11} className="text-white" />
            </span>
            Telepy
        </span>
    );
}

/** `titled`：自己帶標題（放在對話框裡時，標題已經是對話框的）。/ `titled`: its own caption (off inside a dialog that already says it). */
export function ForwardKinds({ active, values = EXAMPLE_FORWARD_VALUES, only, titled = true, className }: { active?: ForwardKind | null; values?: ForwardValues; only?: ForwardKind[]; titled?: boolean; className?: string }) {
    const { t } = useI18n();
    const L = values.local;
    const R = values.remote;
    const D = values.socks;
    const lanes: { kind: ForwardKind; title: string; what: string; row: React.ReactNode }[] = [
        {
            kind: "local",
            title: t("fwdKinds.local"),
            what: t("fwdKinds.localWhat", { local: L.local, host: L.host, port: L.port }),
            row: (
                <>
                    <Node icon={Laptop} label={t("fwdKinds.you")} port={`:${L.local}`} starts />
                    <Link tunnel />
                    <Telepy />
                    <Link tunnel />
                    <Node icon={Cpu} label={t("fwdKinds.device")} />
                    <Link />
                    <Node icon={Server} label={L.host} port={`:${L.port}`} />
                </>
            ),
        },
        {
            kind: "remote",
            title: t("fwdKinds.remote"),
            what: t("fwdKinds.remoteWhat", { remote: R.remote, local: R.local }),
            row: (
                <>
                    <Node icon={Laptop} label={t("fwdKinds.you")} port={`:${R.local}`} />
                    <Link back tunnel />
                    <Telepy />
                    <Link back tunnel />
                    <Node icon={Cpu} label={t("fwdKinds.device")} port={`:${R.remote}`} starts />
                </>
            ),
        },
        {
            kind: "socks",
            title: t("fwdKinds.socks"),
            what: t("fwdKinds.socksWhat", { local: D.local }),
            row: (
                <>
                    <Node icon={Laptop} label={t("fwdKinds.browser")} port={`:${D.local}`} starts />
                    <Link tunnel />
                    <Telepy />
                    <Link tunnel />
                    <Node icon={Cpu} label={t("fwdKinds.device")} />
                    <Link />
                    <Node icon={Globe} label={t("fwdKinds.anywhere")} />
                </>
            ),
        },
    ];
    return (
        <figure className={cn("@container min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-card", className)} aria-label={t("fwdKinds.title")}>
            {titled && <figcaption className="border-b border-border px-4 py-2.5 text-sm text-foreground">{t("fwdKinds.title")}</figcaption>}
            <ul className="divide-y divide-border">
                {lanes.filter((l) => !only || only.includes(l.kind)).map((l) => (
                    <li key={l.kind} className={cn("min-w-0 space-y-2.5 px-4 py-3", active && active !== l.kind && "opacity-55", active === l.kind && "bg-surface")}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Chip mono>{FLAG[l.kind]}</Chip>
                            <span className="text-sm text-foreground">{l.title}</span>
                            <span className="ml-auto font-mono text-xs text-muted-foreground">{VIA[l.kind]}</span>
                        </div>
                        <div className="flex min-w-0 flex-col items-center gap-0.5 @lg:flex-row @lg:gap-1.5" aria-hidden>
                            {l.row}
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">{l.what}</p>
                    </li>
                ))}
            </ul>
        </figure>
    );
}
