"use client";

/**
 * 用 SSH 主機的名稱開網頁時（例如 telepy-ssh.example.com，而網頁在 PUBLIC_URL）換成一頁說明：那個名稱只是給 SSH 用的，
 * 網頁在這裡。後端那邊同時擋住該名稱的登入（421 `ssh_host`），所以這頁不是裝飾：留在這裡也登不進去。
 * 畫面跟 404 頁同一家：一個像素路標（SSH 往這扇門、網頁往另一邊）和 Tapi——走錯門的人才看得到它，所以算彩蛋。
 * 規則跟後端一樣（`lib/signinLook.onSshHost`）：PUBLIC_URL 與 SSH 主機都有、兩者不同、而且這裡的主機就是 SSH 主機時才
 * 顯示；還不知道設定之前照常畫（靜態 HTML 保持中性），所以不會閃。
 * When the web was opened through the SSH host's name, replace the page with one note: that name is for SSH, the web
 * is at PUBLIC_URL. The backend refuses sign-ins through that name too (421 `ssh_host`), so this is not decoration.
 * Same family as the 404 page: a pixel signpost (SSH through this door, the web the other way) and Tapi — only people
 * at the wrong door ever see it, which makes it an egg. Same rule as the backend (`onSshHost`); until the look is known
 * the page renders as usual, so nothing flashes.
 */
import React, { useState, useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";
import { Tapi } from "@/components/brand/Tapi";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { useSignInLook } from "@/hooks/useSignInLook";
import { useI18n } from "@/lib/i18n";
import { onSshHost, publicPageUrl } from "@/lib/signinLook";

const subscribe = () => () => {};
const hostname = () => window.location.hostname;
const pathAndQuery = () => `${window.location.pathname}${window.location.search}`;

export function SshHostGate({ children }: { children: React.ReactNode }) {
    const look = useSignInLook();
    const here = useSyncExternalStore(subscribe, hostname, () => "");
    const page = useSyncExternalStore(subscribe, pathAndQuery, () => "/");
    if (!look || !here || !onSshHost(look, here)) return <>{children}</>;
    return <SshHostNotice sshHost={look.sshHost ?? here} target={publicPageUrl(look, page)} webHost={look.webHost ?? ""} />;
}

// 像素路標：一根柱子、兩塊指示牌（上：往左，網頁；下：往右，SSH）。跟 404 的傳送門同一種畫法（原創、直線直角）。
// A pixel signpost: one post, two boards (top: pointing left, the web; bottom: pointing right, SSH). Drawn like the
// 404 page's portal (original art, straight lines and right angles).
const SIGNPOST = [
    "........................",
    "..WWWWWWWWWWWWWW........",
    ".WwwwwwwwwwwwwwW........",
    "WwwwwwwwwwwwwwwW........",
    ".WwwwwwwwwwwwwwW........",
    "..WWWWWWWWWWWWWW........",
    "...........PP...........",
    "...........PP...........",
    "........SSSSSSSSSSSSSS..",
    "........SsssssssssssssS.",
    "........SssssssssssssssS",
    "........SsssssssssssssS.",
    "........SSSSSSSSSSSSSS..",
    "...........PP...........",
    "...........PP...........",
    "...........PP...........",
    "...........PP...........",
    "..........GGGG..........",
    ".........GGGGGG.........",
];
const SIGN_FILL: Record<string, string> = { W: "#7a5230", w: "#e9c48e", S: "#0c3a35", s: "#2b9c86", P: "#5c3d22", G: "#3f6f4a" };

function Signpost() {
    return (
        <svg viewBox="0 0 24 19" shapeRendering="crispEdges" className="h-[9.5rem] w-[12rem]" aria-hidden>
            {SIGNPOST.flatMap((row, y) =>
                [...row].map((c, x) => (SIGN_FILL[c] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={SIGN_FILL[c]} /> : null)),
            )}
        </svg>
    );
}

export function SshHostNotice({ sshHost, webHost, target }: { sshHost: string; webHost: string; target: string | null }) {
    const { t, tn } = useI18n();
    const [waving, setWaving] = useState(false);
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground [overflow-wrap:anywhere]">{s}</code>;
    return (
        <main className="grid min-h-dvh place-items-center bg-background px-4 py-16 text-foreground">
            <div className="flex w-full max-w-md flex-col items-center text-center">
                {/* 路標旁邊站著 Tapi：指到或點一下會揮手。/ Tapi beside the signpost; waves when pointed at or tapped. */}
                <div
                    className="relative h-[10rem] w-[19.5rem] cursor-default select-none"
                    onMouseEnter={() => setWaving(true)}
                    onMouseLeave={() => setWaving(false)}
                    onClick={() => setWaving((w) => !w)}
                >
                    <div className="absolute bottom-0 left-0">
                        <Signpost />
                    </div>
                    {/* 牌子上的字：上牌 = 網頁（往左），下牌 = SSH（往右）。/ The boards' words: web on top, SSH below. */}
                    {/* 牌子是 0.5rem 一格：上牌第 1–5 列、第 1–15 欄；下牌第 8–12 列、第 8–23 欄。/ Boards on a 0.5rem grid. */}
                    <span className="absolute top-[1rem] left-[0.5rem] grid h-[1.5rem] w-[7.5rem] place-items-center truncate font-mono text-[0.72rem] leading-none text-[#3b2a16]">← {t("sshHostGate.signWeb")}</span>
                    <span className="absolute top-[4.5rem] left-[4rem] grid h-[1.5rem] w-[8rem] place-items-center truncate font-mono text-[0.72rem] leading-none text-[#e4fff7]">{t("sshHostGate.signSsh")} →</span>
                    <div className="absolute right-0 bottom-[0.4rem] animate-fade-in-up">
                        <div className="animate-tapi-bob">
                            <Tapi pose={waving ? "wave" : "surprised"} size="6.5rem" label={t("eggs.tapiLabel")} />
                        </div>
                    </div>
                </div>
                <Chip mono className="mt-6">{sshHost}</Chip>
                <h1 className="mt-3 text-2xl tracking-tight">{t("sshHostGate.title")}</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{tn("sshHostGate.body", { ssh: code(sshHost), web: code(webHost) })}</p>
                {target ? (
                    <Button asChild className="mt-6">
                        <a href={target}>
                            {t("sshHostGate.go", { host: webHost })} <ArrowRight size={16} aria-hidden />
                        </a>
                    </Button>
                ) : null}
                <p className="mt-6 max-w-sm text-xs leading-relaxed text-muted-foreground">{t("sshHostGate.why")}</p>
            </div>
        </main>
    );
}
