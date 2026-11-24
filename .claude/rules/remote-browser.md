---
paths:
  - "src/backend-api/src/remote_browser/**"
  - "src/backend-api/src/api/remote_browser.rs"
  - "src/backend-api/src/lan/device_self.rs"
  - "src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx"
  - "src/frontend/src/components/tunnels/DevicePorts.tsx"
  - "src/frontend/src/hooks/useDevicePorts.ts"
  - "src/frontend/src/lib/devicePorts*.ts"
  - "docs/remote-browser*.md"
---

# Remote browser panel

Design and internals are in `docs/remote-browser.md`; scripted browsers (MCP `browser_*`, `/api/browser/sessions*`) are in `mcp.md` and `cli.md`; LAN web pages and the dock's browser tab are in `lan.md`.

- **The device's own ports ("On this device"; `api/remote_browser.rs` `device_ports`, pure `lan/device_self.rs` `browse_ports` + `NOT_WEB_PORTS`; tests `browse_ports_put_web_pages_first_and_never_offer_ssh`, step 0 of `a_scan_lists_the_devices_own_services_its_gateway_and_what_changed` in `tests/lan_api.rs`; frontend pure + tested `lib/devicePorts.ts`, `hooks/useDevicePorts.ts`, `components/tunnels/DevicePorts.tsx`):** `GET /api/reverse/server/{id}/remote-browser/ports?username=` (VIEW + step-up + an allowed account, feature `remote_browser`, token scope `browser:use` with the tunnel in the path) runs the scan's `LISTEN_POSIX` (then `LISTEN_WINDOWS`) **once, as the person's own account** over `pool.session_channel` — nothing is probed, nothing is stored, and it works without scan rights because it shows no more than `ss` in their terminal would. `browse_ports` keeps the ports reachable on localhost (`local_ports`) and classifies each: `seen` (the stored `source = self` row's services say http / https — its scheme and title win), `no` (the scan saw another protocol, or the port is in `NOT_WEB_PORTS`), `usual` (`lan/web.rs` table), `maybe` (anything else, tried over http); web first, by port. URLs are always `localhost` (the browser connects from the device). Answer `{tunnel_id, username, listed, scanned, ports [{port, web, scheme, url, title, proto, loopback_only}]}`; errors `{error, code: no_account | username | device_offline | ports_failed}`. Same data: MCP `browser_ports` (audited, refuses step-up tunnels) and `telepy browse ports <tunnel>[@account]` (`port_rows`). The panel asks only while it is on screen (`visible` — the terminal page keeps it mounted behind the terminal) and not in the Network dock (`bare`): tiles under the start steps when stopped (a click = `nextUrlRef` + start), the header's **Ports** popover while starting / running (a click = `openTab`, queued while starting). Port names: the scan's title → its protocol → `lib/lanConnect.serviceName` (never "HTTP" for a web port). Copy under `browser.ports.*`.
