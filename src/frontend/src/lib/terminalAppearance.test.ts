import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_TERMINAL_BOLD,
    effectiveAppearance,
    hasProfileOverride,
    isSchemeId,
    parseTerminalProfile,
    resolveTerminalAppearance,
    terminalScheme,
    xtermBoldOptions,
    type TerminalDefaults,
    type TerminalScheme,
} from "./terminalAppearance.ts";

const defaults: TerminalDefaults = { font: "hack", fontSize: 14, scheme: "nord", bold: "face", ligatures: true };
const custom: TerminalScheme[] = [{ id: "custom-abcd1234", name: "Mine", kind: "dark", custom: true, theme: terminalScheme("dracula").theme }];

test("every field says which layer supplied it", () => {
    const e = effectiveAppearance(defaults, null);
    assert.equal(e.font.value.id, "hack");
    assert.equal(e.font.from, "default");
    assert.equal(e.scheme.value.id, "nord");
    assert.equal(e.bold.value, "face");
    // Hack 沒有連字:值 false、來源仍是預設層。/ Hack has no ligatures: false, source still the default layer.
    assert.equal(e.ligatures.value, false);
    assert.equal(e.ligatures.from, "default");

    const d = effectiveAppearance(defaults, { font: "fira-code", font_size: 18, scheme: "custom-abcd1234", bold: "bright", ligatures: null }, custom);
    assert.equal(d.font.value.id, "fira-code");
    assert.equal(d.font.from, "device");
    assert.equal(d.fontSize.value, 18);
    assert.equal(d.fontSize.from, "device");
    assert.equal(d.scheme.value.name, "Mine");
    assert.equal(d.scheme.from, "device");
    assert.equal(d.bold.value, "bright");
    assert.equal(d.bold.from, "device");
    // 連字跟隨預設(true)而且 Fira Code 有。/ Ligatures inherit (true) and Fira Code has them.
    assert.equal(d.ligatures.value, true);
    assert.equal(d.ligatures.from, "default");
});

test("unknown or out-of-range override values inherit (a deleted custom scheme falls back to the default)", () => {
    const e = effectiveAppearance(defaults, { font: "comic-sans", font_size: 99, scheme: "custom-gone", bold: "heavy", ligatures: false });
    assert.equal(e.font.from, "default");
    assert.equal(e.fontSize.value, 14);
    assert.equal(e.scheme.value.id, "nord");
    assert.equal(e.scheme.from, "default");
    assert.equal(e.bold.value, DEFAULT_TERMINAL_BOLD);
    assert.equal(e.ligatures.from, "device");
    // 預設層指到已刪的自訂配色 → 內建預設。/ The default layer pointing at a deleted custom scheme → the built-in default.
    const r = resolveTerminalAppearance({ ...defaults, scheme: "custom-gone" }, null, custom);
    assert.equal(r.scheme.id, "telepy");
    assert.equal(resolveTerminalAppearance({ ...defaults, scheme: "custom-abcd1234" }, null, custom).scheme.id, "custom-abcd1234");
});

test("profile parsing, override detection and the bold options", () => {
    assert.deepEqual(parseTerminalProfile({ font: "hack", font_size: "12", scheme: null, bold: "both", ligatures: "yes" }), { font: "hack", font_size: null, scheme: null, bold: "both", ligatures: null });
    assert.equal(hasProfileOverride({ font: null, font_size: null, scheme: null, bold: null, ligatures: false }), true);
    assert.equal(hasProfileOverride({ font: null, font_size: null, scheme: null, bold: null, ligatures: null }), false);
    assert.deepEqual(xtermBoldOptions("face"), { fontWeight: 400, fontWeightBold: 700, drawBoldTextInBrightColors: false });
    assert.deepEqual(xtermBoldOptions("bright"), { fontWeight: 400, fontWeightBold: 400, drawBoldTextInBrightColors: true });
    assert.deepEqual(xtermBoldOptions("both"), { fontWeight: 400, fontWeightBold: 700, drawBoldTextInBrightColors: true });
    assert.ok(isSchemeId("custom-1a2b3c4d") && isSchemeId("solarized-dark") && !isSchemeId("Hack Nerd") && !isSchemeId(""));
});
