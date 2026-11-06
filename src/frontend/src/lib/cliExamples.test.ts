/**
 * CLI 範例只有一份：`src/cli/src/examples.rs`。這個測試讀它、產生 `cliExamples.gen.ts`（`UPDATE_CLI_EXAMPLES=1 npm test`），
 * 檢查產生檔沒過時，並要求 `en.ts` 的範例 / 主題文字跟 Rust 一字不差（繁中、日文由型別保證存在）。
 * The CLI examples exist once, in `src/cli/src/examples.rs`. This test reads it, writes `cliExamples.gen.ts`
 * (`UPDATE_CLI_EXAMPLES=1 npm test`), checks the generated file is current, and requires `en.ts`'s example and topic
 * texts to equal the Rust ones (zh-TW and ja exist by type).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { en } from "../locales/en.ts";
import { CLI_EXAMPLES, CLI_EXAMPLE_TOPICS } from "./cliExamples.gen.ts";

const RS = new URL("../../../cli/src/examples.rs", import.meta.url);
const GEN = new URL("./cliExamples.gen.ts", import.meta.url);

const STRING = /"((?:[^"\\]|\\.)*)"/g;
const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

function str(block: string, name: string): string {
    const m = block.match(new RegExp(`\\n\\s*${name}: "((?:[^"\\\\]|\\\\.)*)",`));
    assert.ok(m, `field ${name} in ${block.slice(0, 80)}`);
    return unescape(m[1]);
}

function list(block: string, name: string): string[] {
    const m = block.match(new RegExp(`\\n\\s*${name}: &\\[(.*)\\],`));
    assert.ok(m, `field ${name} in ${block.slice(0, 80)}`);
    return [...m[1].matchAll(STRING)].map((x) => unescape(x[1]));
}

interface RustTopic {
    id: string;
    title: string;
    intro: string;
}
interface RustExample {
    id: string;
    topic: string;
    title: string;
    note: string;
    lines: string[];
    needs: string[];
}

function parse(src: string): { topics: RustTopic[]; examples: RustExample[] } {
    const topicsPart = src.slice(src.indexOf("pub const TOPICS"), src.indexOf("pub const EXAMPLES"));
    const examplesPart = src.slice(src.indexOf("pub const EXAMPLES"), src.indexOf("// ---------------------------------------------------------------- reading the lines"));
    const topics = topicsPart.split("Topic {").slice(1).map((b) => ({ id: str(b, "id"), title: str(b, "title"), intro: str(b, "intro") }));
    const examples = examplesPart.split("Example {").slice(1).map((b) => ({
        id: str(b, "id"),
        topic: str(b, "topic"),
        title: str(b, "title"),
        note: str(b, "note"),
        lines: list(b, "lines"),
        needs: list(b, "needs"),
    }));
    return { topics, examples };
}

const q = (v: unknown) => JSON.stringify(v);

function generate(topics: RustTopic[], examples: RustExample[]): string {
    const out = [
        "// 由 src/cli/src/examples.rs 產生（`UPDATE_CLI_EXAMPLES=1 npm test`），不要手改。",
        "// Generated from src/cli/src/examples.rs (`UPDATE_CLI_EXAMPLES=1 npm test`); don't edit by hand.",
        "",
        `export type CliTopicId = ${topics.map((t) => q(t.id)).join(" | ")};`,
        "",
        "/** 主題順序；`intro` = 有沒有開頭一句（`cli.topic.<id>Intro`）。/ Topic order; `intro` = has an opening sentence. */",
        "export const CLI_EXAMPLE_TOPICS = [",
        ...topics.map((t) => `    { id: ${q(t.id)}, intro: ${t.intro !== ""} },`),
        "] as const satisfies readonly { id: CliTopicId; intro: boolean }[];",
        "",
        "/** 範例：`cli.ex.<id>` / `cli.ex.<id>Note` 是標題與說明。/ Examples; `cli.ex.<id>` / `cli.ex.<id>Note` are the title and note. */",
        "export const CLI_EXAMPLES = [",
        ...examples.map((e) => `    { id: ${q(e.id)}, topic: ${q(e.topic)}, lines: [${e.lines.map(q).join(", ")}], needs: [${e.needs.map(q).join(", ")}] },`),
        "] as const satisfies readonly { id: string; topic: CliTopicId; lines: readonly string[]; needs: readonly string[] }[];",
        "",
    ];
    return out.join("\n");
}

const { topics, examples } = parse(readFileSync(RS, "utf8"));

test("the generated examples are current", () => {
    const want = generate(topics, examples);
    if (process.env.UPDATE_CLI_EXAMPLES) writeFileSync(GEN, want);
    assert.equal(readFileSync(GEN, "utf8"), want, "run UPDATE_CLI_EXAMPLES=1 npm test after changing src/cli/src/examples.rs");
    assert.equal(examples.length, CLI_EXAMPLES.length);
    assert.deepEqual(CLI_EXAMPLE_TOPICS.map((t) => t.id), topics.map((t) => t.id));
});

test("en.ts says exactly what the CLI says", () => {
    const dict = en as Record<string, string>;
    for (const t of topics) {
        assert.equal(dict[`cli.topic.${t.id}`], t.title, `cli.topic.${t.id}`);
        if (t.intro) assert.equal(dict[`cli.topic.${t.id}Intro`], t.intro, `cli.topic.${t.id}Intro`);
    }
    for (const e of examples) {
        assert.equal(dict[`cli.ex.${e.id}`], e.title, `cli.ex.${e.id}`);
        assert.equal(dict[`cli.ex.${e.id}Note`], e.note, `cli.ex.${e.id}Note`);
    }
});

test("example ids never take the page's own cli.ex keys", () => {
    const own = ["title", "description", "topic", "for", "offlineOption", "placeholder", "ciActions"];
    for (const e of examples) assert.ok(!own.includes(e.id), `${e.id} is one of the page's own keys`);
});
