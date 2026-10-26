"use client";

/**
 * Webhooks 頁共用的小元件：服務圖示、事件名稱、延遲的文字、狀態點。
 * Small shared pieces for the Webhooks page: service icon, event names, delay wording, state dot.
 */
import React from "react";
import { BellRing, Braces, Hash, MessageCircle, MessagesSquare, Send, Users, Webhook as WebhookIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EVENT_KEYS, type HookState } from "@/lib/webhooks";
import type { WebhookFormat } from "@/types/webhooks";

const FORMAT_ICON: Record<WebhookFormat, React.ComponentType<{ size?: number; className?: string }>> = {
    auto: WebhookIcon,
    json: Braces,
    slack: Hash,
    discord: MessagesSquare,
    google_chat: MessageCircle,
    teams: Users,
    telegram: Send,
    ntfy: BellRing,
};

/** 服務的方塊圖示（中性色，不放品牌色）。/ The service tile (neutral, no brand colours). */
export function ServiceTile({ format, className }: { format: WebhookFormat; className?: string }) {
    const Icon = FORMAT_ICON[format];
    return (
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface text-muted-foreground", className)} aria-hidden>
            <Icon size={18} />
        </span>
    );
}

/** 事件名稱（不認得的照原樣）。/ An event's name (unknown ones as they are). */
export function useEventLabel() {
    const { t } = useI18n();
    return (event: string) => {
        const k = EVENT_KEYS[event];
        return k ? t(k.label) : event;
    };
}

/** 延遲的說法：立刻 / 30 秒 / 1 分鐘…。/ A delay in words. */
export function useDelayLabel() {
    const { t } = useI18n();
    return (secs: number) => {
        if (secs <= 0) return t("webhooks.delay.now");
        if (secs % 3600 === 0) return secs === 3600 ? t("webhooks.delay.hour") : t("webhooks.delay.hours", { n: secs / 3600 });
        if (secs % 60 === 0) return secs === 60 ? t("webhooks.delay.minute") : t("webhooks.delay.minutes", { n: secs / 60 });
        return t("webhooks.delay.seconds", { n: secs });
    };
}

const DOT: Record<HookState, string> = {
    ok: "bg-success",
    failing: "bg-destructive",
    paused: "bg-warning",
    off: "bg-muted-foreground/40",
    never: "border border-dashed border-muted-foreground/70",
};

export function StateDot({ state, className }: { state: HookState; className?: string }) {
    return <span className={cn("inline-flex size-2 shrink-0 rounded-full", DOT[state], className)} aria-hidden />;
}
