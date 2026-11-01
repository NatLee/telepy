import { test } from "node:test";
import assert from "node:assert/strict";
import { createTapiStore, type TapiPatch, type TapiPrefs } from "./tapiStore.ts";

/** 假伺服器：每次送出都排隊，測試決定何時回、成功或失敗。/ A fake server whose answers the test releases. */
function fakeServer(initial: TapiPrefs) {
    let stored = initial;
    const sent: TapiPatch[] = [];
    const queue: ((ok: boolean) => void)[] = [];
    const send = (patch: TapiPatch) => {
        sent.push(patch);
        return new Promise<TapiPrefs | null>((resolve) =>
            queue.push((ok) => {
                if (!ok) return resolve(null);
                stored = { color: patch.tapi_color ?? stored.color, daily: patch.tapi_daily ?? stored.daily, visits: patch.tapi_visits ?? stored.visits };
                resolve(stored);
            }),
        );
    };
    const answer = async (ok = true) => {
        queue.shift()?.(ok);
        await new Promise((r) => setTimeout(r, 0));
    };
    return { send, sent, answer, stored: () => stored };
}

test("a click shows at once, before the server answers", async () => {
    const s = createTapiStore();
    s.seed({ color: "teal", daily: false, visits: true });
    const server = fakeServer({ color: "teal", daily: false, visits: true });
    let changes = 0;
    s.subscribe(() => changes++);
    const done = s.save({ tapi_color: "pink" }, server.send);
    assert.equal(s.get().color, "pink");
    assert.equal(changes, 1);
    await server.answer();
    assert.equal(await done, true);
    assert.equal(s.get().color, "pink");
    assert.equal(changes, 1); // 伺服器同意，不再重畫 / the server agreed: no second render
});

test("rapid clicks are coalesced and sent in order; the last one wins", async () => {
    const s = createTapiStore();
    s.seed({ color: "teal", daily: true, visits: true });
    const server = fakeServer({ color: "teal", daily: true, visits: true });
    const first = s.save({ tapi_color: "pink" }, server.send);
    const second = s.save({ tapi_color: "blue" }, server.send);
    const third = s.save({ tapi_color: "gold" }, server.send);
    assert.equal(s.get().color, "gold");
    assert.equal(server.sent.length, 1); // 第一筆在路上，其他排隊 / the first is in flight, the rest wait
    await server.answer();
    assert.equal(s.get().color, "gold"); // 第一筆的回應不會把畫面拉回 pink / the first answer does not pull it back
    assert.deepEqual(server.sent, [{ tapi_color: "pink" }, { tapi_color: "gold" }]);
    await server.answer();
    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
    assert.equal(s.get().color, "gold");
    assert.equal(server.stored().color, "gold");
});

test("a failed save goes back to the last confirmed value", async () => {
    const s = createTapiStore();
    s.seed({ color: "teal", daily: false, visits: true });
    const server = fakeServer({ color: "teal", daily: false, visits: true });
    const done = s.save({ tapi_color: "pink" }, server.send);
    assert.equal(s.get().color, "pink");
    await server.answer(false);
    assert.equal(await done, false);
    assert.equal(s.get().color, "teal");
});

test("a thrown send counts as a failure", async () => {
    const s = createTapiStore();
    s.seed({ color: "teal", daily: false, visits: true });
    const ok = await s.save({ tapi_color: "pink" }, () => Promise.reject(new Error("offline")));
    assert.equal(ok, false);
    assert.equal(s.get().color, "teal");
});

test("the profile does not overwrite a save in flight, and seeds afterwards", async () => {
    const s = createTapiStore();
    s.seed({ color: "teal", daily: false, visits: true });
    const server = fakeServer({ color: "teal", daily: false, visits: true });
    const done = s.save({ tapi_color: "pink", tapi_daily: true }, server.send);
    s.seed({ color: "teal", daily: false, visits: true }); // 送出前就發出的 profile 請求 / a profile fetched before the save
    assert.deepEqual(s.get(), { color: "pink", daily: true, visits: true });
    await server.answer();
    await done;
    s.seed({ color: "blue", daily: true, visits: true }); // 另一個分頁改的 / changed in another tab
    assert.deepEqual(s.get(), { color: "blue", daily: true, visits: true });
    s.reset();
    assert.deepEqual(s.get(), { color: "", daily: false, visits: true });
});

test("turning visits off is a save like any other", async () => {
    const s = createTapiStore();
    s.seed({ color: "teal", daily: false, visits: true });
    const server = fakeServer({ color: "teal", daily: false, visits: true });
    const done = s.save({ tapi_visits: false }, server.send);
    assert.equal(s.get().visits, false);
    await server.answer();
    assert.equal(await done, true);
    assert.deepEqual(server.stored(), { color: "teal", daily: false, visits: false });
});
