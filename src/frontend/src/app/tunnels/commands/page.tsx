"use client";

/**
 * 指令規則頁：我的規則（管我是 owner / Admin 的隧道上的人，或只管我自己）、唯讀的全站規則、等我核准的指令與紀錄。
 * `?tunnel=<id>` 看一條隧道上生效的規則、`?tab=history` 開紀錄。全站規則在管理區的全站指令規則頁改。
 * The Command rules page: my rules (for people on tunnels I own or administer, or just myself), the read-only
 * site-wide rules, the commands waiting for my approval and the history. `?tunnel=<id>` shows one tunnel's rules in
 * force, `?tab=history` opens the history. Site-wide rules are edited on the admin section's Site command rules page.
 */
import React, { Suspense } from "react";
import { CommandRulesView } from "@/components/commands/CommandRulesView";

export default function CommandsPage() {
    return (
        <Suspense fallback={null}>
            <CommandRulesView view="mine" />
        </Suspense>
    );
}
