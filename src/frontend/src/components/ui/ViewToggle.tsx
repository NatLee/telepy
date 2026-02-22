"use client";

import React, { useEffect, useState, useRef } from "react";
import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ViewToggleProps {
    value: "list" | "card";
    onChange: (value: "list" | "card") => void;
    storageKey?: string;
}

export function ViewToggle({ value, onChange, storageKey }: ViewToggleProps) {
    const [mounted, setMounted] = useState(false);
    // Keep track of previous desktop state to only trigger onChange when crossing the boundary
    const wasDesktopRef = useRef<boolean | null>(null);

    useEffect(() => {
        setMounted(true);

        const checkWidth = () => {
            const isDesktop = window.innerWidth >= 1200;
            const prev = wasDesktopRef.current;

            if (prev === null) {
                // Initialization phase (first time running checkWidth)
                if (!isDesktop) {
                    onChange("card");
                } else {
                    const saved = storageKey ? localStorage.getItem(storageKey) : null;
                    onChange(saved === "list" ? "list" : "card"); // Default to card if not explicitly list
                }
            } else if (prev !== isDesktop) {
                // Resize phase: We crossed the boundary
                if (!isDesktop) {
                    onChange("card"); // Force to card when going small
                } else {
                    // When returning to desktop, we can restore the user's preference from memory
                    // (User said memory is for initialization and not continuously updated,
                    // so we read it here ONLY when crossing the boundary, not on every pixel resize)
                    const saved = storageKey ? localStorage.getItem(storageKey) : null;
                    onChange(saved === "card" ? "card" : "list");
                }
            }

            wasDesktopRef.current = isDesktop;
        };

        checkWidth();

        let timeoutId: NodeJS.Timeout;
        const handleResize = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(checkWidth, 150);
        };

        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
            clearTimeout(timeoutId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    const handleToggle = (newValue: "list" | "card") => {
        if (value === newValue) return;
        onChange(newValue);
        if (storageKey) {
            localStorage.setItem(storageKey, newValue);
        }
    };

    if (!mounted) {
        return (
            <div className="flex bg-muted/50 p-0.5 rounded-lg border border-border" role="group" aria-label="View toggle">
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground"><LayoutGrid size={16} /></Button>
                <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground"><List size={16} /></Button>
            </div>
        );
    }

    return (
        <div className="flex bg-muted/50 p-0.5 rounded-lg border border-border" role="group" aria-label="View toggle">
            <Button
                variant={value === "card" ? "default" : "ghost"}
                size="sm"
                className={`h-8 px-2.5 ${value === "card" ? "shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => handleToggle("card")}
                aria-label="Card view"
                aria-pressed={value === "card"}
                title="Card view"
            >
                <LayoutGrid size={16} />
            </Button>
            <Button
                variant={value === "list" ? "default" : "ghost"}
                size="sm"
                className={`h-8 px-2.5 ${value === "list" ? "shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => handleToggle("list")}
                aria-label="List view"
                aria-pressed={value === "list"}
                title="List view"
            >
                <List size={16} />
            </Button>
        </div>
    );
}
