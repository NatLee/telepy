import { test } from "node:test";
import assert from "node:assert/strict";
import { shownCrumbs } from "./breadcrumbs.ts";

const links = (r: ReturnType<typeof shownCrumbs>) => r.map((c) => `${c.label}${c.link ? "→" : ""}${c.current ? "*" : ""}`).join(" / ");

test("on a section's own page only the earlier crumbs are links", () => {
    assert.equal(links(shownCrumbs([{ label: "Telepy", href: "/tunnels" }, { label: "Tunnels", href: "/tunnels" }], "/tunnels")), "Telepy→ / Tunnels*");
});

test("a page below a section links the section back", () => {
    // 通道頁面：通道能點回去，通道名稱是現在這頁。/ A tunnel's page: Tunnels leads back, the name is the page.
    assert.equal(
        links(shownCrumbs([{ label: "Telepy", href: "/tunnels" }, { label: "Tunnels", href: "/tunnels" }, { label: "office-nas" }], "/tunnels/1")),
        "Telepy→ / Tunnels→ / office-nas*",
    );
    // 沒有自己那一段的深一層頁面：區段本身就要能點。/ A deeper page without its own crumb: the section itself links back.
    assert.equal(links(shownCrumbs([{ label: "Telepy", href: "/tunnels" }, { label: "Live sessions", href: "/tunnels/sessions" }], "/tunnels/sessions/watch")), "Telepy→ / Live sessions→*");
});
