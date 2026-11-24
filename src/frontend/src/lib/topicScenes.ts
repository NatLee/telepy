/**
 * 指令速查「telepy CLI 還能做的事」每個主題的路徑圖（純資料）：這類指令從哪裡出發、經過 Telepy 的哪一段、最後到哪裡。
 * 一個主題一條直線：節點（你的電腦 / CI / Telepy / 裝置 / 好幾台裝置 / 區網主機）與節點之間那一段的說明。
 * 埠轉發沒有在這裡：它有自己的三條方向圖（`ForwardKinds`）。
 * The path diagram of each "More with the telepy CLI" topic on the command sheet (pure data): where such a command
 * starts, which part of Telepy it goes through and where it ends. One straight line per topic: the spots and the label
 * of each link between them. Port forwarding is not here: it has its own three-direction diagram (`ForwardKinds`).
 */
import type { TranslationKey } from "../locales/en.ts";
import type { CliTopicId } from "./cliExamples.gen.ts";

export type SceneSpot = "you" | "ci" | "telepy" | "device" | "devices" | "lan";

export interface TopicScene {
    nodes: { spot: SceneSpot; sub: TranslationKey }[];
    /** 第 i 段連著第 i 與第 i+1 個節點。/ Link i joins node i and node i + 1. */
    links: TranslationKey[];
}

export type SceneTopic = Exclude<CliTopicId, "forward">;

/** 節點的名字（Telepy 是品牌名，不翻譯）。/ A spot's name (Telepy is the brand, never translated). */
export const SPOT_TITLE: Record<Exclude<SceneSpot, "telepy">, TranslationKey> = {
    you: "sheet.ways.you",
    ci: "sheet.topic.spotCi",
    device: "sheet.ways.device",
    devices: "sheet.topic.spotDevices",
    lan: "sheet.topic.spotLan",
};

export const TOPIC_SCENES: Record<SceneTopic, TopicScene> = {
    everyday: {
        nodes: [
            { spot: "you", sub: "sheet.topic.everydayYou" },
            { spot: "telepy", sub: "sheet.ways.gatewayApi" },
            { spot: "device", sub: "sheet.ways.deviceSub" },
        ],
        links: ["sheet.topic.linkBoth", "sheet.ways.tunnel"],
    },
    many: {
        nodes: [
            { spot: "you", sub: "sheet.topic.manyYou" },
            { spot: "telepy", sub: "sheet.topic.manyTelepy" },
            { spot: "devices", sub: "sheet.topic.manyDevices" },
        ],
        links: ["sheet.topic.linkApi", "sheet.topic.linkEach"],
    },
    files: {
        nodes: [
            { spot: "you", sub: "sheet.topic.filesYou" },
            { spot: "telepy", sub: "sheet.ways.gatewayApi" },
            { spot: "device", sub: "sheet.topic.filesDevice" },
        ],
        links: ["sheet.topic.filesLink", "sheet.ways.tunnel"],
    },
    sessions: {
        nodes: [
            { spot: "you", sub: "sheet.topic.sessionsYou" },
            { spot: "telepy", sub: "sheet.topic.sessionsTelepy" },
            { spot: "device", sub: "sheet.topic.sessionsDevice" },
        ],
        links: ["sheet.topic.linkApi", "sheet.ways.tunnel"],
    },
    toolbox: {
        nodes: [
            { spot: "you", sub: "sheet.topic.toolboxYou" },
            { spot: "telepy", sub: "sheet.topic.toolboxTelepy" },
            { spot: "device", sub: "sheet.topic.toolboxDevice" },
        ],
        links: ["sheet.topic.linkApi", "sheet.topic.toolboxLink"],
    },
    network: {
        nodes: [
            { spot: "you", sub: "sheet.topic.networkYou" },
            { spot: "telepy", sub: "sheet.ways.gatewayApi" },
            { spot: "device", sub: "sheet.topic.networkDevice" },
            { spot: "lan", sub: "sheet.topic.networkLan" },
        ],
        links: ["sheet.topic.linkBoth", "sheet.ways.tunnel", "sheet.topic.networkLink"],
    },
    ci: {
        nodes: [
            { spot: "ci", sub: "sheet.topic.ciRunner" },
            { spot: "telepy", sub: "sheet.topic.ciTelepy" },
            { spot: "devices", sub: "sheet.topic.manyDevices" },
        ],
        links: ["sheet.topic.ciLink", "sheet.topic.linkEach"],
    },
    setup: {
        nodes: [
            { spot: "you", sub: "sheet.topic.setupYou" },
            { spot: "telepy", sub: "sheet.topic.setupTelepy" },
        ],
        links: ["sheet.topic.setupLink"],
    },
};

/** 主題的一句話：這類指令是做什麼的。/ A topic's one sentence: what these commands are for. */
export const topicWhat = (id: CliTopicId): TranslationKey => `sheet.topic.${id}What` as TranslationKey;

/** 範例的指令填上這個人的帳號（沒有可用帳號時留著 `<account>`）。/ An example's lines with the person's account filled in (`<account>` stays when there is none). */
export function fillAccount(lines: string[], account: string | null): string[] {
    if (!account || !/^[A-Za-z0-9._-]+$/.test(account)) return lines;
    return lines.map((l) => l.replaceAll("<account>", account));
}
