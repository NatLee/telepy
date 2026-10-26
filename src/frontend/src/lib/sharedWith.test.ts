import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAREE_PREVIEW_MAX, shareePreview } from "./sharedWith.ts";

const people = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}`);

test("short lists are shown whole", () => {
    assert.deepEqual(shareePreview([]), { shown: [], more: 0 });
    assert.deepEqual(shareePreview(people(3)), { shown: people(3), more: 0 });
    assert.deepEqual(shareePreview(people(SHAREE_PREVIEW_MAX)), { shown: people(8), more: 0 });
});

test("long lists stop at eight and count the rest", () => {
    const r = shareePreview(people(11));
    assert.deepEqual(r.shown, people(8));
    assert.equal(r.more, 3);
    assert.deepEqual(shareePreview(people(5), 5, 2), { shown: ["user1", "user2"], more: 3 });
});

test("the count wins when it is ahead of the names", () => {
    assert.equal(shareePreview(people(2), 4).more, 2);
    assert.equal(shareePreview(people(3), 1).more, 0, "never negative");
});
