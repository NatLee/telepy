"use client";

/**
 * 密碼欄位 + 顯示 / 隱藏切換。其餘 props（autoComplete、id、aria-*…）原樣傳給 <Input>。
 * Password field with a show / hide toggle; every other prop (autoComplete, id, aria-*…) goes to <Input>.
 */
import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
    const [visible, setVisible] = useState(false);
    const { t } = useI18n();
    const label = visible ? t("auth.hidePassword") : t("auth.showPassword");

    return (
        <div className="relative">
            <Input type={visible ? "text" : "password"} className={cn("pr-11", className)} {...props} />
            <button
                type="button"
                onClick={() => setVisible((v) => !v)}
                title={label}
                aria-label={label}
                aria-pressed={visible}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
        </div>
    );
}
