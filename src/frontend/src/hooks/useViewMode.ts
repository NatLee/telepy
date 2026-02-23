import { useState, useEffect } from "react";

export function useViewMode(storageKey: string, defaultMode: "list" | "card" = "card") {
    const [viewMode, setViewMode] = useState<"list" | "card">(defaultMode);

    useEffect(() => {
        if (typeof window !== "undefined") {
            if (window.innerWidth < 1200) {
                setViewMode("card");
            } else {
                const saved = localStorage.getItem(storageKey);
                setViewMode(saved === "card" ? "card" : "list");
            }
        }
    }, [storageKey]);

    return [viewMode, setViewMode] as const;
}
