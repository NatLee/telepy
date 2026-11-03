import { test } from "node:test";
import assert from "node:assert/strict";
import { clueStates, confidenceTone, evidenceSentence, familyKey, osBlock, privateIpv4, sortedEvidence } from "./lanOs.ts";
import type { LanOsCheck } from "@/types/lan";

const check = (over: Partial<LanOsCheck> = {}): LanOsCheck => ({
    family: "windows",
    name: "Windows 11 23H2 (build 22631)",
    confidence: "high",
    evidence: [
        { source: "ttl", text: "ping TTL 128", family: "windows", weight: 1 },
        { source: "ssh", text: "SSH greeting: OpenSSH_9.8 (no distribution tag)", weight: 0 },
        { source: "smb", text: "SMB on port 445: Windows 10.0 build 22631", family: "windows", weight: 5 },
    ],
    conflict: [],
    nmap: "absent",
    at: "2026-11-04T10:00:00+08:00",
    by: "alice",
    ...over,
});

test("families and confidence have their words and tones", () => {
    assert.equal(familyKey("windows"), "network.os.family.windows");
    assert.equal(familyKey("plan9"), null);
    assert.equal(confidenceTone("high"), "success");
    assert.equal(confidenceTone("medium"), "warning");
    assert.equal(confidenceTone("none"), "muted");
});

test("heavier clues come first, notes last", () => {
    assert.deepEqual(sortedEvidence(check()).map((e) => e.source), ["smb", "ttl", "ssh"]);
});

test("only private IPv4 hosts with the scan permission, online", () => {
    assert.equal(privateIpv4("192.168.1.20"), true);
    assert.equal(privateIpv4("8.8.8.8"), false);
    assert.equal(privateIpv4("nas.local"), false);
    assert.equal(privateIpv4("192.168.1.300"), false);
    const h = { address: "192.168.1.20", own: false, source: "scan" as const };
    assert.equal(osBlock(h, true, true), null);
    assert.equal(osBlock(h, false, true), "permission");
    assert.equal(osBlock(h, true, false), "offline");
    assert.equal(osBlock({ ...h, address: "nas.local" }, true, true), "address");
    assert.equal(osBlock({ ...h, own: true }, true, true), "own");
});

test("clue lanes say what was used, what wasn't there and what wasn't asked", () => {
    const host = { open_ports: [445, 22], services: [], vendor: null, os_check: check() };
    const s = clueStates(host);
    assert.equal(s.smb, "used");
    assert.equal(s.ttl, "used");
    assert.equal(s.ssh, "note");
    assert.equal(s.nmap, "skipped", "absent on the device");
    assert.equal(s.http, "skipped", "no web server in the last scan");
    assert.equal(s.vendor, "skipped");
    const nginx = clueStates({ ...host, services: [{ port: 80, proto: "http", server: "nginx" }], vendor: "Intel Corporate" });
    assert.deepEqual([nginx.http, nginx.vendor], ["note", "note"], "read, but they name no OS");
    const ran = clueStates({ ...host, os_check: check({ nmap: "ran" }) });
    assert.equal(ran.nmap, "nothing", "ran but said nothing");
    const before = clueStates({ open_ports: [80], services: [{ port: 80, proto: "http", server: "nginx" }], vendor: "Apple, Inc.", os_check: null });
    assert.deepEqual([before.ttl, before.http, before.vendor, before.smb], ["unknown", "unknown", "unknown", "skipped"]);
});

test("clues become sentences in the viewer's language", () => {
    const ttl = evidenceSentence({ source: "ttl", text: "", weight: 1, data: { ttl: 63, start: 64, hops: 1 } });
    assert.deepEqual(ttl, { key: "network.os.ev.ttl", vars: { ttl: "63", start: "64", hops: "1", what: "network.os.family.unix" } });
    assert.equal(evidenceSentence({ source: "ssh", text: "", weight: 0, data: { line: "OpenSSH_9.8", tagged: false } })?.key, "network.os.ev.sshPlain");
    const smb = evidenceSentence({ source: "smb", text: "", weight: 5, data: { port: 445, major: 10, minor: 0, build: 22631, samba: false, computer: "pc", domain: "WORKGROUP" } });
    assert.deepEqual(smb, { key: "network.os.ev.smbBoth", vars: { port: "445", version: "10.0", build: "22631", name: "pc", domain: "WORKGROUP" } });
    assert.equal(evidenceSentence({ source: "smb", text: "", weight: 3, data: { port: 445, major: 6, minor: 1, build: 0, samba: true, computer: "nas", domain: null } })?.key, "network.os.ev.smbSambaNamed");
    assert.equal(evidenceSentence({ source: "ssh", text: "older", weight: 4 }), null, "no data = the backend's text");
});
