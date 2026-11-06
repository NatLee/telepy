/**
 * 說明文字裡的 `-R`、`--open`、`--` 不在連字號後面斷行（瀏覽器會在 `(-` 和 `R)` 之間換行）。
 * Keeps `-R` / `--open` in running text on one line (browsers break right after the hyphen otherwise).
 */
import React from "react";

export function FlagText({ text }: { text: string }) {
    const parts = text.split(/((?<![\w/-])(?:--(?:[A-Za-z][A-Za-z0-9-]*)?|-[A-Za-z][A-Za-z0-9-]*))/);
    return (
        <>
            {parts.map((p, i) => (i % 2 === 1 ? <span key={i} className="whitespace-nowrap">{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>))}
        </>
    );
}
