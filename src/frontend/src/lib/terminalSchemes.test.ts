import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSI_KEYS, TERMINAL_SCHEMES } from "./terminalAppearance.ts";
import {
    colorsFromScheme,
    customToScheme,
    normalizeHex,
    parseBase16,
    parseCustomSchemes,
    parseSchemeImport,
    parseWindowsTerminalScheme,
    schemeKind,
    toWindowsTerminalJson,
    validateColors,
} from "./terminalSchemes.ts";

const WT = `{
  "name": "Campbell",
  "background": "#0C0C0C", "foreground": "#CCCCCC", "cursorColor": "#FFFFFF", "selectionBackground": "#FFFFFF",
  "black": "#0C0C0C", "red": "#C50F1F", "green": "#13A10E", "yellow": "#C19C00", "blue": "#0037DA", "purple": "#881798", "cyan": "#3A96DD", "white": "#CCCCCC",
  "brightBlack": "#767676", "brightRed": "#E74856", "brightGreen": "#16C60C", "brightYellow": "#F9F1A5", "brightBlue": "#3B78FF", "brightPurple": "#B4009E", "brightCyan": "#61D6D6", "brightWhite": "#F2F2F2"
}`;

const BASE16 = `scheme: "Default Dark"
author: "Chris Kempson"
base00: "181818"
base01: "282828"
base02: "383838"
base03: "585858"
base04: "b8b8b8"
base05: "d8d8d8"
base06: "e8e8e8"
base07: "f8f8f8"
base08: "ab4642"
base09: "dc9656"
base0A: "f7ca88"
base0B: "a1b56c"
base0C: "86c1b9"
base0D: "7cafc2"
base0E: "ba8baf"
base0F: "a16946"
`;

test("hex colours are normalised", () => {
    assert.equal(normalizeHex("#ABCDEF"), "#abcdef");
    assert.equal(normalizeHex("abcdef"), "#abcdef");
    assert.equal(normalizeHex("#fff"), "#ffffff");
    assert.equal(normalizeHex("red"), null);
    assert.equal(normalizeHex("#12345"), null);
    assert.equal(normalizeHex(12), null);
});

test("a Windows Terminal scheme imports with purple as magenta and the cursor from cursorColor", () => {
    const r = parseWindowsTerminalScheme(WT);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.format, "windows-terminal");
    assert.equal(r.name, "Campbell");
    assert.equal(r.colors.magenta, "#881798");
    assert.equal(r.colors.brightMagenta, "#b4009e");
    assert.equal(r.colors.cursor, "#ffffff");
    assert.equal(r.colors.background, "#0c0c0c");
    // 整個 settings.json 也行(第一個 scheme)。/ A whole settings.json works too (its first scheme).
    const whole = parseSchemeImport(`{"profiles": {}, "schemes": [${WT}]}`);
    assert.ok(whole.ok && whole.name === "Campbell");
});

test("an incomplete or foreign JSON is reported, not imported", () => {
    const r = parseSchemeImport(`{"name": "x", "background": "#000000", "foreground": "#ffffff", "red": "#ff0000", "black": "#000000"}`);
    assert.ok(!r.ok && r.reason === "incomplete" && r.format === "windows-terminal");
    if (!r.ok) assert.ok(r.missing?.includes("green"));
    assert.ok(!parseSchemeImport(`{"profiles": {"defaults": {}}}`).ok);
    assert.deepEqual(parseSchemeImport("{not json"), { ok: false, format: null, reason: "unrecognised" });
    assert.deepEqual(parseSchemeImport("   "), { ok: false, format: null, reason: "empty" });
});

test("base16 YAML maps to ANSI the standard way", () => {
    const r = parseBase16(BASE16);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.format, "base16");
    assert.equal(r.name, "Default Dark");
    assert.equal(r.colors.background, "#181818");
    assert.equal(r.colors.foreground, "#d8d8d8");
    assert.equal(r.colors.selectionBackground, "#383838");
    assert.equal(r.colors.red, "#ab4642");
    assert.equal(r.colors.green, "#a1b56c");
    assert.equal(r.colors.yellow, "#f7ca88");
    assert.equal(r.colors.blue, "#7cafc2");
    assert.equal(r.colors.magenta, "#ba8baf");
    assert.equal(r.colors.cyan, "#86c1b9");
    assert.equal(r.colors.brightBlack, "#585858");
    assert.equal(r.colors.brightWhite, "#f8f8f8");
    assert.equal(r.colors.brightRed, r.colors.red);
    // 自動辨識 + 缺色。/ Detection + missing bases.
    assert.ok(parseSchemeImport(BASE16).ok);
    const short = parseSchemeImport(BASE16.split("\n").slice(0, 10).join("\n"));
    assert.ok(!short.ok && short.reason === "incomplete" && short.format === "base16");
    if (!short.ok) assert.deepEqual(short.missing?.slice(0, 2), ["base08", "base09"]);
    // 大小寫與 # 不拘。/ Case and the hash are optional.
    const r2 = parseBase16(BASE16.replace(/base0a/i, "base0a").replace('"f7ca88"', "'#F7CA88'"));
    assert.ok(r2.ok && r2.colors.yellow === "#f7ca88");
});

test("validateColors lists what is missing or bad and keeps the optionals", () => {
    const base = colorsFromScheme(TERMINAL_SCHEMES[0]);
    const ok = validateColors({ ...base, cursorAccent: "#ABC", selectionForeground: "" });
    assert.ok(ok.ok);
    if (ok.ok) {
        assert.equal(ok.colors.cursorAccent, "#aabbcc");
        assert.equal(ok.colors.selectionForeground, undefined);
    }
    const bad = validateColors({ ...base, red: "red", cyan: undefined, cursorAccent: "nope" });
    assert.ok(!bad.ok);
    if (!bad.ok) {
        assert.deepEqual(bad.missing, ["cyan"]);
        assert.deepEqual(bad.bad, ["red", "cursorAccent"]);
    }
});

test("a custom scheme becomes a TerminalScheme with a kind and a cursor accent", () => {
    const dark = customToScheme({ id: "custom-1", name: "Mine", colors: colorsFromScheme(TERMINAL_SCHEMES[0]) });
    assert.equal(dark.kind, "dark");
    assert.equal(dark.custom, true);
    assert.equal(dark.theme.cursorAccent, dark.theme.background);
    assert.equal(dark.theme.selectionForeground, undefined);
    const light = customToScheme({ id: "custom-2", name: "Paper", colors: { ...colorsFromScheme(TERMINAL_SCHEMES[0]), background: "#fdf6e3", cursorAccent: "#111111", selectionForeground: "#222222" } });
    assert.equal(light.kind, "light");
    assert.equal(light.theme.cursorAccent, "#111111");
    assert.equal(light.theme.selectionForeground, "#222222");
    assert.equal(schemeKind("#000000"), "dark");
    assert.equal(schemeKind("#ffffff"), "light");
});

test("the API list is parsed defensively and exports round-trip through Windows Terminal JSON", () => {
    const colors = colorsFromScheme(TERMINAL_SCHEMES[1]);
    const list = parseCustomSchemes([{ id: "custom-a", name: "A", colors, created_at: "2026-10-27T00:00:00Z" }, { id: "custom-b", name: "B", colors: { red: "#ff0000" } }, "junk"]);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "custom-a");
    assert.deepEqual(parseCustomSchemes(null), []);
    const again = parseWindowsTerminalScheme(toWindowsTerminalJson("A", colors));
    assert.ok(again.ok);
    if (again.ok) for (const k of ANSI_KEYS) assert.equal(again.colors[k], colors[k]);
});
