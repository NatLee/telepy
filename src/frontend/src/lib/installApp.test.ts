import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_NAME_MAX, APP_NAME_MODES, appHost, appNameFor, appNameProblem, homeLabel, installGuide, tidyAppName, type InstallEnv } from "./installApp.ts";

test("the name follows the mode and falls back to Telepy, like the backend", () => {
    assert.equal(appNameFor("telepy", "Lab", "telepy.example.com"), "Telepy");
    assert.equal(appNameFor("domain", "Lab", "telepy.example.com"), "telepy.example.com");
    assert.equal(appNameFor("domain", "", null), "Telepy");
    assert.equal(appNameFor("custom", "  Lab \n servers ", null), "Lab servers");
    assert.equal(appNameFor("custom", "   ", "x.example"), "Telepy");
});

test("custom names are tidied and limited like the backend's check_name", () => {
    assert.equal(tidyAppName("  Lab \t servers  "), "Lab servers");
    assert.equal(appNameProblem("實驗室"), null);
    assert.equal(appNameProblem("字".repeat(APP_NAME_MAX)), null, "characters, not bytes");
    assert.equal(appNameProblem("a".repeat(APP_NAME_MAX + 1)), "tooLong");
    assert.equal(appNameProblem(`  ${"a".repeat(APP_NAME_MAX)}  `), null, "outer whitespace does not count");
    assert.equal(appNameProblem("Lab\u0000"), "control");
    assert.equal(appNameProblem("Lab\nservers"), null, "a newline becomes a space");
});

test("the limits and modes match the backend", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/app_manifest.rs", import.meta.url), "utf8");
    assert.match(rust, new RegExp(`pub const NAME_MAX: usize = ${APP_NAME_MAX};`));
    assert.match(rust, new RegExp(`pub const MODES: \\[&str; ${APP_NAME_MODES.length}\\] = \\[${APP_NAME_MODES.map((m) => `"${m}"`).join(", ")}\\];`));
});

test("the domain is the public address's host, else the current one", () => {
    assert.equal(appHost("https://Lab.Example.org:8443/x", "other.example"), "lab.example.org");
    assert.equal(appHost("", "Telepy.Example.com"), "telepy.example.com");
    assert.equal(appHost("not a url", "here.example"), "here.example");
    assert.equal(appHost(null, ""), null);
});

test("home screens cut long names", () => {
    assert.equal(homeLabel("Telepy"), "Telepy");
    assert.equal(homeLabel("telepy.natlee.info"), "telepy.natl…");
    assert.equal(homeLabel("實驗室的伺服器們一二三四五"), "實驗室的伺服器們一二三…");
});

const env = (ua: string, over: Partial<InstallEnv> = {}): InstallEnv => ({ ua, standalone: false, secure: true, canPrompt: false, touchPoints: 0, ...over });
const UA = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
    androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
};

test("each browser gets its own way to install", () => {
    assert.equal(installGuide(env(UA.iphone)), "ios");
    assert.equal(installGuide(env(UA.ipad, { touchPoints: 5 })), "ios", "iPad Safari says Macintosh");
    assert.equal(installGuide(env(UA.macSafari)), "macSafari");
    assert.equal(installGuide(env(UA.macChrome)), "chromium");
    assert.equal(installGuide(env(UA.edge)), "chromium");
    assert.equal(installGuide(env(UA.android)), "android");
    assert.equal(installGuide(env(UA.androidFirefox)), "android", "Firefox on Android installs from its menu");
    assert.equal(installGuide(env(UA.firefox)), "firefox");
    assert.equal(installGuide(env("curl/8")), "other");
});

test("already installed, no HTTPS and a browser prompt come first", () => {
    assert.equal(installGuide(env(UA.iphone, { standalone: true, secure: false })), "installed");
    assert.equal(installGuide(env(UA.edge, { secure: false, canPrompt: true })), "insecure");
    assert.equal(installGuide(env(UA.edge, { canPrompt: true })), "prompt");
});

test("Ctrl+W reaches the shell only in an app window with the focus in the terminal", async () => {
    const { keyPath } = await import("./installApp.ts");
    assert.equal(keyPath("tab", "terminal").outcome, "tabCloses", "the browser takes it first in a tab");
    assert.equal(keyPath("tab", "elsewhere").outcome, "tabCloses");
    assert.deepEqual(keyPath("app", "terminal"), { window: "ok", terminal: "ok", shell: "ok", outcome: "deletesWord" });
    assert.equal(keyPath("app", "elsewhere").outcome, "windowCloses");
});

test("the theme colours match the backend's manifest", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/app_manifest.rs", import.meta.url), "utf8");
    const light = rust.match(/BACKGROUND_LIGHT: &str = "(#[0-9a-f]{6})"/)?.[1];
    const dark = rust.match(/BACKGROUND_DARK: &str = "(#[0-9a-f]{6})"/)?.[1];
    assert.ok(light && dark);
    for (const file of ["./userPrefs.ts", "../app/layout.tsx"]) {
        const text = readFileSync(new URL(file, import.meta.url), "utf8");
        assert.ok(text.includes(light) && text.includes(dark), `${file} uses ${light} / ${dark}`);
    }
});
