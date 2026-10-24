/**
 * 每個情境的插圖內容（節點 / 連線），以及情境卡片上的迷你插圖。
 * Scene content (nodes / links) per recipe, plus the mini illustration on each recipe card.
 */
import { Cpu, Globe, Laptop, Monitor, Router, SquareTerminal } from "lucide-react";
import type { Translate } from "@/lib/i18n";
import { resolveParams, type ConnectTarget, type RecipeId, type RecipeParams } from "@/lib/forwardRecipes";
import type { MiniItem, SceneLink, SceneNode } from "./TunnelScene";

export function sceneFor(id: RecipeId, rawParams: RecipeParams, target: ConnectTarget, t: Translate): { nodes: SceneNode[]; links: SceneLink[]; file: boolean } {
    const p = resolveParams(id, rawParams);
    const you = (socket?: string, entry = false, name = t("sheet.scene.you")): SceneNode => ({ icon: Laptop, role: "you", name, socket, entry });
    const device = (socket?: string, entry = false): SceneNode => ({
        icon: Cpu,
        role: "device",
        name: target.alias,
        sub: t("sheet.scene.deviceAs", { user: target.username }),
        socket,
        entry,
    });
    const tunnel = (direction: SceneLink["direction"] = "forward"): SceneLink => ({ kind: "tunnel", direction, label: "Telepy" });

    switch (id) {
        case "local":
            return { nodes: [you(`localhost:${p.localPort}`, true), device(`:${p.remotePort}`)], links: [tunnel()], file: false };
        case "lan":
            return {
                nodes: [
                    you(`localhost:${p.localPort}`, true),
                    device(),
                    { icon: Router, role: "target", name: p.lanHost, sub: t("sheet.scene.onItsNetwork"), socket: `:${p.lanPort}` },
                ],
                links: [tunnel(), { kind: "plain", direction: "forward", label: t("sheet.scene.linkLan") }],
                file: false,
            };
        case "socks":
            return {
                nodes: [
                    you(`SOCKS5 :${p.localPort}`, true, t("sheet.scene.yourBrowser")),
                    device(),
                    { icon: Globe, role: "target", name: t("sheet.scene.internet"), sub: t("sheet.scene.internetSub") },
                ],
                links: [tunnel(), { kind: "plain", direction: "forward", label: t("sheet.scene.linkWeb") }],
                file: false,
            };
        case "remote":
            return {
                nodes: [
                    { ...you(`localhost:${p.localPort}`), sub: t("sheet.scene.yourService") },
                    device(`localhost:${p.devicePort}`, true),
                ],
                links: [tunnel("backward")],
                file: false,
            };
        case "jump":
            return {
                nodes: [
                    you(),
                    device(),
                    { icon: SquareTerminal, role: "target", name: `${p.lanUser}@${p.lanHost}`, sub: t("sheet.scene.onItsNetwork"), socket: `:${p.lanPort}` },
                ],
                links: [tunnel(), { kind: "ssh", direction: "forward", label: "SSH" }],
                file: false,
            };
        case "copy": {
            const back = p.direction === "download";
            return {
                nodes: [you(p.localPath), device(p.remotePath)],
                links: [tunnel(back ? "backward" : "forward")],
                file: true,
            };
        }
        case "rustdesk": {
            // 裝置自己的 RustDesk，或它區網裡另一台的。/ RustDesk on the device itself, or on a LAN host.
            const onDevice = p.lanHost === "localhost" || p.lanHost === "127.0.0.1";
            const me = you(`RustDesk → localhost:${p.localPort}`, true);
            if (onDevice) return { nodes: [me, device(`RustDesk :${p.remotePort}`)], links: [tunnel()], file: false };
            return {
                nodes: [me, device(), { icon: Monitor, role: "target", name: p.lanHost, sub: t("sheet.scene.onItsNetwork"), socket: `RustDesk :${p.remotePort}` }],
                links: [tunnel(), { kind: "plain", direction: "forward", label: t("sheet.scene.linkLan") }],
                file: false,
            };
        }
    }
}

const YOU: MiniItem = { icon: Laptop, role: "you" };
const DEVICE: MiniItem = { icon: Cpu, role: "device" };

export const MINI_SCENES: Record<RecipeId, MiniItem[]> = {
    local: [YOU, { link: "tunnel" }, DEVICE],
    lan: [YOU, { link: "tunnel" }, DEVICE, { link: "plain" }, { icon: Router, role: "target" }],
    socks: [YOU, { link: "tunnel" }, DEVICE, { link: "plain" }, { icon: Globe, role: "target" }],
    remote: [YOU, { link: "tunnel", back: true }, DEVICE],
    jump: [YOU, { link: "tunnel" }, DEVICE, { link: "ssh" }, { icon: SquareTerminal, role: "target" }],
    copy: [YOU, { link: "tunnel", both: true }, DEVICE],
    rustdesk: [YOU, { link: "tunnel" }, { icon: Monitor, role: "device" }],
};
