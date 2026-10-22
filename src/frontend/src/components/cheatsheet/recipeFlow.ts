/**
 * 每個情境的流程圖節點與連線（用目前的參數與隧道資訊填上位址與埠）。
 * Diagram nodes and links for each recipe, filled with the current parameters and tunnel info.
 */
import type { Translate } from "@/lib/i18n";
import { jumpServerSpec, resolveParams, type ConnectTarget, type RecipeId, type RecipeParams } from "@/lib/forwardRecipes";
import type { FlowLinkSpec, FlowNode } from "./FlowDiagram";

export function recipeFlow(id: RecipeId, rawParams: RecipeParams, target: ConnectTarget, t: Translate): { nodes: FlowNode[]; links: FlowLinkSpec[] } {
    const p = resolveParams(id, rawParams);
    const server: FlowNode = {
        kind: "server",
        title: t("sheet.node.server"),
        detail: target.serverHost,
        chip: target.mode === "direct" ? jumpServerSpec(target) : `:${target.serverPort || "22"}`,
    };
    const device = (detail: string, chip?: string, entry?: string): FlowNode => ({ kind: "device", title: target.alias, detail, chip, entry });
    const asUser = t("sheet.node.deviceAs", { user: target.username });
    const ssh = (direction: FlowLinkSpec["direction"] = "forward"): FlowLinkSpec => ({ label: t("sheet.link.ssh"), style: "ssh", direction });
    const tunnel = (direction: FlowLinkSpec["direction"] = "forward"): FlowLinkSpec => ({ label: t("sheet.link.tunnel"), style: "ssh", direction });
    const tcp: FlowLinkSpec = { label: t("sheet.link.tcp"), style: "plain", direction: "forward" };

    switch (id) {
        case "local":
            return {
                nodes: [
                    { kind: "you", title: t("sheet.node.you"), chip: `localhost:${p.localPort}`, entry: t("sheet.node.useHere") },
                    server,
                    device(asUser),
                    { kind: "service", title: t("sheet.node.service"), chip: `localhost:${p.remotePort}` },
                ],
                links: [ssh(), tunnel(), tcp],
            };
        case "lan":
            return {
                nodes: [
                    { kind: "you", title: t("sheet.node.you"), chip: `localhost:${p.localPort}`, entry: t("sheet.node.useHere") },
                    server,
                    device(asUser),
                    { kind: "lan", title: t("sheet.node.lanHost"), chip: `${p.lanHost}:${p.lanPort}` },
                ],
                links: [ssh(), tunnel(), tcp],
            };
        case "socks":
            return {
                nodes: [
                    { kind: "you", title: t("sheet.node.yourApps"), chip: `SOCKS5 localhost:${p.localPort}`, entry: t("sheet.node.useHere") },
                    server,
                    device(asUser),
                    { kind: "internet", title: t("sheet.node.internet"), detail: t("sheet.node.internetDetail") },
                ],
                links: [ssh(), tunnel(), tcp],
            };
        case "remote":
            return {
                nodes: [
                    { kind: "you", title: t("sheet.node.yourService"), chip: `localhost:${p.localPort}` },
                    server,
                    device(asUser, `localhost:${p.devicePort}`, t("sheet.node.useHere")),
                ],
                links: [ssh("backward"), tunnel("backward")],
            };
        case "jump":
            return {
                nodes: [
                    { kind: "you", title: t("sheet.node.you") },
                    server,
                    device(t("sheet.node.jumpHost", { user: target.username })),
                    { kind: "lan", title: `${p.lanUser}@${p.lanHost}`, detail: t("sheet.node.lanSsh"), chip: `:${p.lanPort}` },
                ],
                links: [ssh(), tunnel(), ssh()],
            };
        case "copy": {
            const dir = p.direction === "download" ? "backward" : "forward";
            const label = p.tool === "rsync" ? "rsync" : "scp";
            return {
                nodes: [
                    { kind: "you", title: t("sheet.node.you"), chip: p.localPath },
                    server,
                    device(asUser, p.remotePath),
                ],
                links: [{ label, style: "ssh", direction: dir }, { label: t("sheet.link.tunnel"), style: "ssh", direction: dir }],
            };
        }
    }
}
