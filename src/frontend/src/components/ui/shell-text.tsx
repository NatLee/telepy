"use client";

/**
 * 上色的 shell 指令（`lib/shellHighlight`）：一行一個 block，在空白處換行；每個詞是 inline-block，所以 `--online`
 * 不會從連字號切開，只有比一行還寬的詞才在裡面斷。選取 / 複製到的字跟原文一樣。顏色是 `--code-*`（`.code-terminal` 裡用亮的一組）。
 * A coloured shell command (`lib/shellHighlight`): one block per line, wrapping at spaces; each word is an
 * inline-block, so `--online` never breaks at its hyphen and only a word wider than the line breaks inside.
 * Selecting / copying gives the original text. Colours are `--code-*` (the light set inside `.code-terminal`).
 */
import React from "react";
import { highlightShell, type ShellKind, type ShellPiece, type SubcommandTree } from "@/lib/shellHighlight";

export const SHELL_CLASS: Record<ShellKind, string> = {
    telepy: "text-(--code-telepy)",
    cmd: "text-(--code-cmd)",
    sub: "text-(--code-sub)",
    flag: "text-(--code-flag)",
    placeholder: "text-(--code-placeholder) underline decoration-dotted decoration-1 underline-offset-[3px]",
    string: "text-(--code-string)",
    var: "text-(--code-var)",
    op: "text-(--code-muted)",
    comment: "text-(--code-muted)",
    arg: "",
    space: "",
};

/** 片段併成詞（空白之間）。/ Pieces grouped into words (between spaces). */
function words(pieces: ShellPiece[]): ShellPiece[][] {
    const out: ShellPiece[][] = [];
    let cur: ShellPiece[] = [];
    for (const p of pieces) {
        if (p.kind === "space") {
            if (cur.length) out.push(cur);
            cur = [];
        } else cur.push(p);
    }
    if (cur.length) out.push(cur);
    return out;
}

/** `synopsis`：用法說明，不是可以跑的指令（`|` = 或、`[ ]` = 可省）。/ A usage line rather than a runnable command. */
export function ShellText({ value, tree, synopsis = false }: { value: string; tree?: SubcommandTree; synopsis?: boolean }) {
    return (
        <>
            {value.split("\n").map((line, i) => (
                <span key={i} className="block">
                    {words(highlightShell(line, tree, synopsis)).map((word, j) => (
                        <React.Fragment key={j}>
                            {j > 0 && " "}
                            <span className="inline-block max-w-full [overflow-wrap:anywhere]">
                                {word.map((p, k) => (
                                    <span key={k} className={SHELL_CLASS[p.kind] || undefined}>
                                        {p.text}
                                    </span>
                                ))}
                            </span>
                        </React.Fragment>
                    ))}
                </span>
            ))}
        </>
    );
}
