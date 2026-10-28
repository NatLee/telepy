"use client";

/**
 * 指令速查第 ① 步的就緒圖：四項設定各自擺在它所在的地方——你的電腦（SSH 金鑰、~/.ssh/config）─SSH─ Telepy
 * ─隧道─ 裝置（在線、接受你的金鑰）。直線、平面，寬容器橫排、窄容器直排；每一項可以點，點了就在下面的清單打開那一項。
 * The readiness diagram of the command sheet's step ①: each of the four setup items sits where it lives — your
 * computer (SSH key, ~/.ssh/config) ─SSH─ Telepy ─tunnel─ the device (online, trusts your key). Straight lines,
 * flat, a row in a wide container and a column in a narrow one; every item is clickable and opens it in the list.
 */
import React from "react";
import { Check, CircleAlert, Circle, Clock3, Cpu, Laptop, Loader2 } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SpotState } from "@/lib/flow";
import type { ConnectMode } from "@/lib/forwardRecipes";
import type { SetupChecklist, SetupStepId, SetupStepState } from "@/hooks/useSetupChecklist";

const ICON: Record<SetupStepState, React.ReactNode> = {
    done: <Check size={14} strokeWidth={3} className="text-success" />,
    todo: <Circle size={14} className="text-muted-foreground" />,
    working: <Clock3 size={14} className="text-warning" />,
    error: <CircleAlert size={14} className="text-destructive" />,
    loading: <Loader2 size={14} className="animate-spin text-muted-foreground" />,
};

/** 一個地方的幾項合成一個狀態。/ Several items at one place, merged into one state. */
function spot(states: SetupStepState[]): SpotState {
    if (states.some((s) => s === "error")) return "failed";
    if (states.every((s) => s === "done")) return "ok";
    if (states.some((s) => s === "working" || s === "loading")) return "active";
    return "waiting";
}

function Item({ state, label, onClick }: { state: SetupStepState; label: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                state === "done" ? "text-foreground" : state === "error" ? "text-destructive" : "text-muted-foreground",
            )}
        >
            <span className="grid size-4 shrink-0 place-items-center" aria-hidden>{ICON[state]}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        </button>
    );
}

export function ReadinessPath({ checklist, alias, username, online, mode, onOpen }: {
    checklist: SetupChecklist;
    alias: string;
    username: string | null;
    online: boolean;
    mode: ConnectMode;
    onOpen: (id: SetupStepId) => void;
}) {
    const { t } = useI18n();
    const state = (id: SetupStepId) => checklist.steps.find((s) => s.id === id)!.state;
    const count = (ids: SetupStepId[]) => `${ids.filter((id) => state(id) === "done").length} / ${ids.length}`;
    const mine: SetupStepId[] = ["key", "config"];
    const device: SetupStepId[] = ["online", "deviceKey"];
    return (
        <FlowPath stretch>
            <FlowNode
                icon={Laptop}
                title={t("sheet.scene.you")}
                state={spot(mine.map(state))}
                stateText={count(mine)}
                control={
                    <div className="-mx-2 space-y-0.5">
                        <Item state={state("key")} label={t("sheet.ready.key")} onClick={() => onOpen("key")} />
                        <Item state={state("config")} label={mode === "direct" ? t("sheet.ready.direct") : <span className="font-mono">~/.ssh/config</span>} onClick={() => onOpen("config")} />
                    </div>
                }
            />
            <FlowLink label="SSH" state={state("key") === "done" ? "ok" : "waiting"} />
            <FlowNode brand title="Telepy" sub={t("sheet.ready.telepySub")} state="ok" stateText={t("flow.ready")} />
            <FlowLink label={t("sheet.ready.tunnel")} state={online ? "ok" : "failed"} />
            <FlowNode
                icon={Cpu}
                title={alias}
                sub={username ? t("sheet.scene.deviceAs", { user: username }) : undefined}
                state={spot(device.map(state))}
                stateText={count(device)}
                control={
                    <div className="-mx-2 space-y-0.5">
                        <Item state={state("online")} label={online ? t("flow.online") : t("flow.offline")} onClick={() => onOpen("online")} />
                        <Item state={state("deviceKey")} label={t("sheet.ready.deviceKey")} onClick={() => onOpen("deviceKey")} />
                    </div>
                }
            />
        </FlowPath>
    );
}
