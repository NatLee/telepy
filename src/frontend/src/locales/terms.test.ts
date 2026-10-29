/**
 * 用詞一致：繁中的 tunnel 一律寫「通道」（使用者選的）；「隧道」不再出現。新增字串時這個測試會指出漏改的 key。
 * Consistent wording: in Traditional Chinese a tunnel is always 通道 (the user's choice), never 隧道. When new strings
 * are added, this test names the key that slipped through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zhTW } from "./zh-TW.ts";

test("zh-TW calls a tunnel 通道, never 隧道", () => {
    const offenders = Object.entries(zhTW).filter(([, v]) => v.includes("隧道")).map(([k]) => k);
    assert.deepEqual(offenders, [], `use 通道 for "tunnel" in: ${offenders.join(", ")}`);
});
