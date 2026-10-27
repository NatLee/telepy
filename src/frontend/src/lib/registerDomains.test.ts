import { test } from "node:test";
import assert from "node:assert/strict";
import { addDomains, checkAddress, fitsLimit, joinDomains, normalizeDomain, parentInList, parseStored, splitInput, storedLength } from "./registerDomains.ts";

test("a value is lower-cased and loses its @, local part and trailing dot", () => {
    assert.deepEqual(normalizeDomain(" MyCorp.com "), { ok: true, domain: "mycorp.com" });
    assert.deepEqual(normalizeDomain("@mycorp.com"), { ok: true, domain: "mycorp.com" });
    assert.deepEqual(normalizeDomain("Alice@MyCorp.com"), { ok: true, domain: "mycorp.com" });
    assert.deepEqual(normalizeDomain("mycorp.com."), { ok: true, domain: "mycorp.com" });
    assert.deepEqual(normalizeDomain("xn--fiqs8s.cn"), { ok: true, domain: "xn--fiqs8s.cn" });
});

test("bad values say why", () => {
    const why = (v: string) => { const r = normalizeDomain(v); return r.ok ? "ok" : r.reason; };
    assert.equal(why(""), "empty");
    assert.equal(why("@"), "empty");
    assert.equal(why("*.mycorp.com"), "wildcard");
    assert.equal(why("公司.tw"), "unicode");
    assert.equal(why("localhost"), "noDot");
    assert.equal(why("a..com"), "emptyPart");
    assert.equal(why(`${"a".repeat(64)}.com`), "partTooLong");
    assert.equal(why("exa_mple.com"), "badChar");
    assert.equal(why("-a.com"), "hyphen");
    assert.equal(why("a-.com"), "hyphen");
    assert.equal(why("1.2.3.4"), "numericTld");
    assert.equal(why(`${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.com`), "tooLong");
});

test("pasting many splits on commas, spaces, semicolons and newlines", () => {
    assert.deepEqual(splitInput("a.com, b.com;c.com\n d.com  "), ["a.com", "b.com", "c.com", "d.com"]);
    assert.deepEqual(splitInput(" ,, "), []);
});

test("adding skips repeats, sets bad values aside and keeps the order", () => {
    const r = addDomains(["gmail.com"], "MyCorp.com, gmail.com bob@mycorp.com *.x.com nodot");
    assert.deepEqual(r.list, ["gmail.com", "mycorp.com"]);
    assert.deepEqual(r.added, ["mycorp.com"]);
    assert.deepEqual(r.duplicates, ["gmail.com", "mycorp.com"]);
    assert.deepEqual(r.rejected, [{ value: "*.x.com", reason: "wildcard" }, { value: "nodot", reason: "noDot" }]);
});

test("the stored text round-trips and the limit counts the joined text", () => {
    assert.deepEqual(parseStored(" Gmail.com, ,MyCorp.com "), ["gmail.com", "mycorp.com"]);
    assert.equal(joinDomains(["a.com", "b.com"]), "a.com,b.com");
    assert.equal(storedLength(["a.com", "b.com"]), 11);
    const many = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, "0")}.example.com`);
    assert.equal(fitsLimit(many), true);
    assert.equal(fitsLimit(Array.from({ length: 40 }, (_, i) => `d${String(i).padStart(2, "0")}.example.com`)), false);
});

test("an address passes only on an exact domain; a blank list means gmail.com", () => {
    assert.deepEqual(checkAddress("someone@mycorp.com", ["mycorp.com"]), { kind: "allowed", domain: "mycorp.com", usingDefault: false });
    assert.deepEqual(checkAddress("Someone@MyCorp.COM", ["mycorp.com"]), { kind: "allowed", domain: "mycorp.com", usingDefault: false });
    assert.deepEqual(checkAddress("a@sub.mycorp.com", ["mycorp.com"]), { kind: "blocked", domain: "sub.mycorp.com", usingDefault: false });
    assert.deepEqual(checkAddress("a@gmail.com", []), { kind: "allowed", domain: "gmail.com", usingDefault: true });
    assert.deepEqual(checkAddress("a@mycorp.com", []), { kind: "blocked", domain: "mycorp.com", usingDefault: true });
    for (const bad of ["", "mycorp.com", "@mycorp.com", "a@", "  "]) assert.deepEqual(checkAddress(bad, ["mycorp.com"]), { kind: "invalid" });
});

test("a blocked subdomain points at the parent that is listed", () => {
    assert.equal(parentInList("sub.mycorp.com", ["mycorp.com"]), "mycorp.com");
    assert.equal(parentInList("other.com", ["mycorp.com"]), null);
    assert.equal(parentInList("notmycorp.com", ["mycorp.com"]), null);
});

import { coverage, newlyRefused } from "./registerDomains.ts";

const acct = (id: number, email: string, active = true) => ({ id, username: `u${id}`, email, is_active: active });

test("removing a domain names the active accounts that lose Google sign-in", () => {
    const users = [acct(1, "a@gmail.com"), acct(2, "b@MyCorp.com"), acct(3, "c@gmail.com", false), acct(4, ""), acct(5, "d@other.org")];
    assert.deepEqual(newlyRefused(users, ["gmail.com", "mycorp.com"], ["mycorp.com"]).map((u) => u.id), [1]);
    // 加網域不會擋任何人。/ Adding a domain refuses nobody.
    assert.deepEqual(newlyRefused(users, ["gmail.com"], ["gmail.com", "mycorp.com"]), []);
    // 空清單 = gmail.com：第一次加別的網域會把 gmail.com 擠掉。/ An empty list is gmail.com: the first other domain displaces it.
    assert.deepEqual(newlyRefused(users, [], ["mycorp.com"]).map((u) => u.id), [1]);
    // 清空 = 回到預設：mycorp.com 的人被擋。/ Clearing returns to the default: mycorp.com people are refused.
    assert.deepEqual(newlyRefused(users, ["gmail.com", "mycorp.com"], []).map((u) => u.id), [2]);
    assert.deepEqual(newlyRefused(users, ["gmail.com"], []), [], "gmail.com → default changes nothing");
});

test("coverage counts active accounts per domain", () => {
    const users = [acct(1, "a@gmail.com"), acct(2, "b@Gmail.com"), acct(3, "c@gmail.com", false)];
    assert.equal(coverage(users, "gmail.com"), 2);
    assert.equal(coverage(users, "mycorp.com"), 0);
});
