/**
 * 表單欄位:標籤(可標必填 / 選填)+ 控制項 + 提示或錯誤。錯誤時把 aria-invalid 傳給子控制項。
 * Form field: label (required / optional marker) + control + hint or error. Passes aria-invalid down
 * to the control when there is an error.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

interface FieldProps {
    id?: string;
    label: React.ReactNode;
    /** 標籤右側的小字(例如「選填」)或動作。/ Small text or an action at the right of the label. */
    addon?: React.ReactNode;
    required?: boolean;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    children: React.ReactElement<{ id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string }>;
    className?: string;
}

export function Field({ id, label, addon, required, hint, error, children, className }: FieldProps) {
    const reactId = React.useId();
    const controlId = id ?? children.props.id ?? `field-${reactId}`;
    const messageId = `${controlId}-message`;
    const control = React.cloneElement(children, {
        id: controlId,
        "aria-invalid": error ? true : children.props["aria-invalid"],
        "aria-describedby": hint || error ? messageId : children.props["aria-describedby"],
    });
    return (
        <div className={cn("space-y-1.5", className)}>
            <div className="flex items-center justify-between gap-2">
                <Label htmlFor={controlId}>
                    {label}
                    {required && <span className="text-destructive" aria-hidden>*</span>}
                </Label>
                {addon && <span className="text-xs text-muted-foreground">{addon}</span>}
            </div>
            {control}
            {error ? (
                <p id={messageId} className="text-xs leading-relaxed text-destructive" role="alert">{error}</p>
            ) : hint ? (
                <p id={messageId} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}
