import { test } from "node:test";
import assert from "node:assert/strict";
import { lanAuthFrame, lanAuthFromValue, lanAuthParam, lanAuthValue } from "./lanAuth.ts";

test("the LAN hop's login choice round-trips through the URL param and select value", () => {
    assert.deepEqual(lanAuthFromValue(undefined), { kind: "telepy" });
    assert.deepEqual(lanAuthFromValue("telepy"), { kind: "telepy" });
    assert.deepEqual(lanAuthFromValue("prompt"), { kind: "prompt" });
    assert.deepEqual(lanAuthFromValue("cred:12"), { kind: "credential", id: 12 });
    assert.deepEqual(lanAuthFromValue("cred:x"), { kind: "telepy" });
    assert.equal(lanAuthValue({ kind: "credential", id: 7 }), "cred:7");
    // 預設不進網址。/ The default stays out of the URL.
    assert.equal(lanAuthParam({ kind: "telepy" }), undefined);
    assert.equal(lanAuthParam({ kind: "prompt" }), "prompt");
    assert.deepEqual(lanAuthFrame({ kind: "credential", id: 3 }), { lan_auth: "credential", lan_credential_id: "3" });
    assert.deepEqual(lanAuthFrame({ kind: "prompt" }), { lan_auth: "prompt" });
});
