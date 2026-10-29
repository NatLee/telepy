import { test } from "node:test";
import assert from "node:assert/strict";
import { snugFits } from "./snugBody.ts";

test("only an overflow made of bottom padding is absorbed, and the decision is stable", () => {
    // 剛好放得下 / fits already
    assert.equal(snugFits(0, false, 20), false);
    // 超出 6 px（< 20 px 的留白）→ 收掉 / 6 px over, all of it padding → snug
    assert.equal(snugFits(6, false, 20), true);
    // 收掉之後：現在 −14 px，原本 6 px → 還是收著 / once snug: −14 now, 6 naturally → stays snug
    assert.equal(snugFits(-14, true, 20), true);
    // 剛好等於留白 / exactly the padding
    assert.equal(snugFits(20, false, 20), true);
    // 超出比留白多：真的有內容在下面，照常捲 / more than the padding: real content below, scroll as usual
    assert.equal(snugFits(38, false, 20), false);
    // 收著時內容變高到超過留白 → 打開 / content grew past the padding while snug → back to normal
    assert.equal(snugFits(5, true, 20), false);
    // 收著時內容變矮到不超出 → 打開 / content shrank so it fits with padding → back to normal
    assert.equal(snugFits(-25, true, 20), false);
});
