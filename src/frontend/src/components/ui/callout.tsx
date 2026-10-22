/**
 * 提示框:取代各處手刻的藍 / 黃色說明框(💡 / ⚠️)。淡色底 + 左側圖示,深淺色模式共用語意色。
 * Callout: replaces the hand-rolled blue / amber notice boxes. Tinted surface + leading icon, built
 * on the semantic colour tokens so light and dark mode both work.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, Info, Lightbulb, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const calloutVariants = cva(
    "flex items-start gap-3 rounded-xl px-3.5 py-3 text-sm leading-relaxed ring-1 ring-inset [&_code]:rounded-md [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.85em]",
    {
        variants: {
            tone: {
                info: "bg-info/8 text-foreground/85 ring-info/20 [&_code]:bg-info/12 [&>svg]:text-info",
                tip: "bg-primary/7 text-foreground/85 ring-primary/20 [&_code]:bg-primary/12 [&>svg]:text-primary",
                warning: "bg-warning/10 text-foreground/85 ring-warning/30 [&_code]:bg-warning/15 [&>svg]:text-warning",
                danger: "bg-destructive/8 text-foreground/85 ring-destructive/20 [&_code]:bg-destructive/12 [&>svg]:text-destructive",
            },
        },
        defaultVariants: { tone: "info" },
    },
);

const ICONS = { info: Info, tip: Lightbulb, warning: TriangleAlert, danger: CircleAlert } as const;

function Callout({
    className,
    tone = "info",
    icon,
    children,
    ...props
}: React.ComponentProps<"div"> & VariantProps<typeof calloutVariants> & { icon?: React.ReactNode }) {
    const Icon = ICONS[tone ?? "info"];
    return (
        <div data-slot="callout" role="note" className={cn(calloutVariants({ tone }), className)} {...props}>
            {icon ?? <Icon size={17} className="mt-0.5 shrink-0" aria-hidden />}
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

export { Callout, calloutVariants };
