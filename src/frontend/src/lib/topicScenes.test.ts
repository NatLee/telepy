import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../locales/en.ts";
import { CLI_EXAMPLE_TOPICS } from "./cliExamples.gen.ts";
import { SPOT_TITLE, TOPIC_SCENES, fillAccount, topicWhat } from "./topicScenes.ts";

const has = (k: string) => typeof (en as Record<string, string>)[k] === "string";

test("every CLI topic but port forwarding has a path, and every topic has its sentence", () => {
    const topics = CLI_EXAMPLE_TOPICS.map((t) => t.id);
    assert.deepEqual(Object.keys(TOPIC_SCENES).sort(), topics.filter((t) => t !== "forward").sort());
    for (const id of topics) assert.ok(has(topicWhat(id)), `${id} has no sentence`);
});

test("a path is one line through Telepy: a link between every two spots, all of it worded", () => {
    for (const [id, scene] of Object.entries(TOPIC_SCENES)) {
        assert.equal(scene.links.length, scene.nodes.length - 1, `${id}: links`);
        assert.equal(scene.nodes.filter((n) => n.spot === "telepy").length, 1, `${id}: goes through Telepy once`);
        assert.notEqual(scene.nodes[0].spot, "telepy", `${id}: starts at a computer`);
        for (const n of scene.nodes) {
            assert.ok(has(n.sub), `${id}: ${n.sub}`);
            if (n.spot !== "telepy") assert.ok(has(SPOT_TITLE[n.spot]), `${id}: ${n.spot}`);
        }
        for (const l of scene.links) assert.ok(has(l), `${id}: ${l}`);
    }
});

test("the account is filled in only when it is safe to paste", () => {
    assert.deepEqual(fillAccount(["telepy ssh pi@<account>", "telepy ls"], "ubuntu"), ["telepy ssh pi@ubuntu", "telepy ls"]);
    assert.deepEqual(fillAccount(["telepy ssh pi@<account>"], null), ["telepy ssh pi@<account>"]);
    assert.deepEqual(fillAccount(["telepy ssh pi@<account>"], "a b; rm"), ["telepy ssh pi@<account>"]);
});
