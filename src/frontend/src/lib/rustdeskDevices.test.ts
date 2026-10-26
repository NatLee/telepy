import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceDetails, endReasonKey, enrolSteps, formatRustDeskId, guessOs, serverProblemKey, shortOs, sortDevices, type RustDeskDevice } from "./rustdeskDevices.ts";

test("RustDesk IDs are grouped like RustDesk shows them", () => {
    assert.equal(formatRustDeskId("113668456"), "113 668 456");
    assert.equal(formatRustDeskId("1234567890"), "1 234 567 890");
    assert.equal(formatRustDeskId("nat-office-01"), "nat-office-01");
});

test("OS strings and card details", () => {
    assert.equal(shortOs("debian / Linux 12 Debian GNU/Linux"), "Linux 12");
    assert.equal(shortOs("Windows 11 Pro / 10.0.22631"), "Windows 11");
    assert.equal(shortOs("macOS 15.1"), "macOS 15.1");
    assert.equal(shortOs(""), "");
    assert.equal(deviceDetails({ name: "Office PC", hostname: "office-pc", os: "debian / Linux 12", version: "1.5.0" }), "office-pc · Linux 12 · RustDesk 1.5.0");
    assert.equal(deviceDetails({ name: "kiosk-3", hostname: "kiosk-3", os: "", version: "" }), "", "the hostname is not repeated when it is the name");
});

test("address problems map to explanations", () => {
    assert.equal(serverProblemKey(null), null);
    assert.equal(serverProblemKey("hostname_port"), "rustdesk.problem.hostnamePort");
    assert.equal(serverProblemKey("bad_url"), "rustdesk.problem.badUrl");
});

test("the default command tab follows the browser", () => {
    assert.equal(guessOs({ platform: "Win32" }), "windows");
    assert.equal(guessOs({ platform: "MacIntel" }), "macos");
    assert.equal(guessOs({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
    assert.equal(guessOs(undefined), "linux");
});

test("enrolment steps", () => {
    assert.deepEqual(enrolSteps("waiting", false), ["active", "todo", "todo"]);
    assert.deepEqual(enrolSteps("waiting", true), ["todo", "todo", "todo"]);
    assert.deepEqual(enrolSteps("enrolled", false), ["done", "done", "active"]);
    assert.deepEqual(enrolSteps("online", true), ["done", "done", "done"]);
});

test("online devices come first", () => {
    const d = (id: number, name: string, online: boolean) => ({ id, name, online }) as RustDeskDevice;
    assert.deepEqual(sortDevices([d(1, "b", false), d(2, "a", false), d(3, "z", true)]).map((x) => x.id), [3, 2, 1]);
});

test("end reasons map to explanations", () => {
    assert.equal(endReasonKey("user"), "rustdesk.history.reason.user");
    assert.equal(endReasonKey("ended"), "rustdesk.history.reason.ended");
    assert.equal(endReasonKey("restart"), "rustdesk.history.reason.restart");
    assert.equal(endReasonKey("something new"), "rustdesk.history.reason.other");
});
