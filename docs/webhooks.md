# Webhooks

<p align="center"><b>English</b> | <a href="./webhooks.zh-TW.md">繁體中文</a> | <a href="./webhooks.ja.md">日本語</a></p>

> Everyone can send the Telepy notifications they would receive anyway to Slack, Discord, Google Chat, Microsoft Teams, Telegram, ntfy (phone push)
> or their own service; admins can also run "site-wide" webhooks that carry the important events of the whole server.
> Backend: `webhooks/` (`catalog.rs` event catalogue, `text.rs` sentences in three languages, `format.rs` per-service formats, `sign.rs` signing,
> `target.rs` address check, `mod.rs` delivery); `api/webhooks.rs`, `db/webhooks.rs`; the timing of status alerts lives in `monitor/alerts.rs` + `monitor/runner.rs`.
> Frontend: `/tunnels/webhooks` = my webhooks (admins see only their own there; the site-wide webhooks are listed read-only below them), `/tunnels/admin/webhooks` =
> site-wide webhooks (sidebar admin section "Rules & alerts → Webhooks"); both pages share `components/webhooks/WebhooksView.tsx` (`hooks/useWebhooksPage.ts`,
> `lib/webhooks.ts`), and the opt-out dialogs are in `components/webhooks/OptOut.tsx`.

## Two kinds of webhook

| | Personal webhook | Site-wide webhook |
| --- | --- | --- |
| Who creates / manages it | Each person, for themselves (nobody else can see it) | Admins; every admin can see and edit it |
| What it carries | The notifications that person already gets in the web UI | A curated set of important events (status, device identity and security, accounts) |
| Scope | Tunnels the person owns or that are shared with them (can be narrowed to a few) | Every tunnel and every account (can be limited to chosen tunnels) |
| Private addresses | Not allowed by default (see "Address check") | Allowed |
| What others can see | Nothing | Everyone sees a summary on their own Webhooks page (no URL, headers or secret) |
| Can a tunnel be excluded | — | "Default" mode: a tunnel's owner and ADMIN sharees can opt their own tunnels out; "Enforced" mode: they cannot |

Site settings → Notifications tab (`notify_*`):

- `notify_user_webhooks` (on by default): turning it off pauses every personal webhook; site-wide ones are unaffected.
- `notify_private_targets` (off by default): whether personal webhooks may reach private networks, localhost and cloud metadata.
- `notify_max_webhooks` (default 10, 0–100): the per-person limit.

Admins can also turn the "Personal webhooks" feature off for certain people (or a user group) under Users & access → Feature permissions (`/tunnels/admin/access`):
that person's Webhooks page is replaced by an explanation, and `/api/webhooks*` answers 403 `feature_disabled` (the two routes for opting out of site-wide webhooks are not affected).
When an account is disabled, its personal webhooks stop sending.

The former single alert URL (`notify_webhook_url` / `notify_down_delay`) was moved during the upgrade (data migration
`2026-10-26-site-webhook-from-settings`) into a site-wide webhook named "Status alerts": the same four status events plus
`tunnel.ip_changed`, the same delay, and the old settings were cleared.

## Site-wide webhooks: who sees them, who can opt out

![Where a tunnel's events go: event, site-wide webhook, opt-out, channel](images/en/webhook-optout.png)

**Everyone can see them.** Under their own webhooks, the personal Webhooks page has a read-only "Site-wide webhooks" section: name, service (Slack, Teams…),
events, which tunnels it covers (only the ones that person can see; the rest are just counted), on / paused.
The URL, custom headers, signing secret, delivery history and creator are never shown.
Regular users see only webhooks that are on, or paused because they keep failing; admins see a "Manage" link there, but changes are still made on the site-wide Webhooks page in the admin section.

**Two modes** (`mode`, site-wide webhooks only):

- **Default** (`default`): "Let people override" is on in the admin dialog (this is the default for new webhooks, and for site-wide webhooks that existed before the upgrade).
  A tunnel's **owner or ADMIN sharee** can opt that tunnel out of the webhook: in the site-wide section of the Webhooks page, press "Opt my tunnels out"
  and switch tunnels off one by one (only tunnels they manage that this webhook covers are listed; tunnels that someone else already opted out also show up).
- **Enforced** (`enforced`): "Let people override" is off and the card shows an "Enforced" chip. Every covered tunnel is always sent, nobody can opt out, and earlier opt-outs are ignored for now.

Delivery rule (`webhooks::opted_out`): an event about a tunnel is not sent to a default-mode site-wide webhook as soon as **any current** manager of that tunnel
(the owner, plus sharees whose permission is ADMIN, read at the moment of delivery) has opted out; when someone loses ADMIN, their opt-out stops counting.
Account events (failed sign-in, new user) cannot be opted out of; personal webhooks have no opt-out. Status alerts (offline / online / degraded / recovered) follow the same rule;
test sends and re-sends ignore opt-outs.

On a site-wide webhook's card, admins see "N opted out"; opening it shows which tunnel, who opted out, when, and whether it still counts. Every opt-out or cancelled opt-out is recorded
as a `webhook_optout` event in that tunnel's Logs. When a tunnel or a webhook is deleted, the related opt-outs are deleted with it. The "How opt-outs work" button in the site-wide section opens a diagram:
event ─ site-wide webhook ─ opt-out ─ admins' channel; pick a webhook and a tunnel and it lights up whether the event is sent and which layer decides.

## Events

Recipients always follow the in-app notification for the same event, so a webhook never tells anyone about something they cannot see in the web UI; after a share is ended
or a permission is lowered, events of that tunnel are no longer sent to that person.

| Event | Group | Who receives it (personal webhook) | Site-wide |
| --- | --- | --- | --- |
| `tunnel.offline` / `tunnel.online` | Tunnel status | The owner and all sharees | ✓ |
| `tunnel.degraded` / `tunnel.recovered` | Tunnel status | The owner and all sharees | ✓ |
| `tunnel.ip_changed` | Device identity | The owner and ADMIN sharees | ✓ |
| `tunnel.host_key_changed` | Device identity | The owner and all sharees | ✓ |
| `device.claim_attempt` | Device identity | The owner and ADMIN sharees | ✓ |
| `tunnel.device_warning` | Device identity | The owner and ADMIN sharees (root disk under 10 % or 2 GB free, available memory under 10 %, 1-minute load above twice the CPU count, reboot pending; at most once a day per tunnel and kind; data has `warning` / `detail` / `avail` / `total` / `load1` / `cpus`) | ✓ |
| `share.received` | Sharing and access | The person it was shared with | |
| `share.ended` | Sharing and access | Both sides of the share, except whoever did it | |
| `access.requested` | Sharing and access | The owner and ADMINs, except the requester | |
| `access.decided` | Sharing and access | The requester | |
| `command.approval_requested` | Command rules | The approvers of that rule (the people the rule names, otherwise the owner and ADMINs; not sent for commands typed in your own terminal, but sent for commands from your own MCP agent) | |
| `command.approval_decided` | Command rules | The requester (not sent when they decided or cancelled it themselves) | |
| `command.blocked` | Command rules | The owner and ADMINs, except the person involved; the message includes the command | |
| `session.started` | Connections | The owner and ADMINs, except the person involved (terminal, LAN terminal, files, browser, desktop, RustDesk) | |
| `session.watched` | Connections | The person being watched (the owner / an ADMIN / an admin starts watching their web terminal; data has `by` / `account` / `lan_host`) | |
| `mcp.session_opened` / `mcp.session_closed` | Connections | The agent's user and the tunnel owner (`kind` in data: `ssh` or `browser`) | |
| `account.sign_in` | Sign-in | The account holder | |
| `account.sign_in_new_device` | Sign-in | The account holder (a country or browser not seen in any successful sign-in within 90 days) | |
| `account.sign_in_failed` | Sign-in | The account holder | ✓ (any account) |
| `key.expiring` | SSH keys | The key's owner (a personal SSH key expires within 7 days) | |
| `key.expired` | SSH keys | The key's owner (just expired: the gateway refuses it and it is removed from devices) | |
| `user.created` | Administration | — | ✓ |
| `webhook.test` | — | The "Send test" button; cannot be subscribed to | |

`key.*` is about the **personal SSH keys** on the Keys page (the one a laptop uses to reach devices through the gateway; admins give them a lifetime with `user_key_max_days`).
Tunnel (device) keys deliberately never expire, so there is no event for them. The check runs every 10 minutes (`webhooks/keys.rs`): a key expiring within 7 days sends `key.expiring`
(`days_left` rounded up), an expired one sends `key.expired` (only keys that expired in the last 48 hours; older expiries are not sent retroactively); each key sends each stage once per expiry time
(`telepy_key_expiry_notice`), and a renewal that changes the expiry time starts over.

Status events (offline / online / degraded / recovered) are not sent the instant they happen: each webhook has its own delay (immediately – 1 day, default 1 minute),
and the condition must last longer than the delay; online / recovered is only sent when offline / degraded was sent before. Only changes after the webhook was created are tracked.

### How this relates to in-page toasts and desktop notifications

![How an in-app or desktop notification is decided](images/en/notify-flow.png)

In-page notifications (toasts) and desktop notifications have their own preferences (Preferences → Notifications; admins set site-wide defaults under Rules & alerts → Notifications
and can enforce some events so they are always shown; each tunnel's menu can also mute that tunnel's status or all of its notifications). Those settings **only decide what the browser shows**
and do not affect webhooks: an event you turned off or muted in the web UI is still sent to a personal webhook that subscribes to it; conversely, a webhook looks only at its own event list, its tunnel filter and
(for site-wide ones) opt-outs.

## What is sent

Each webhook picks a format (by default detected from the URL) and a message language (English / 繁體中文 / 日本語; the sentences are built in the backend, because the message goes straight into a chat room).

| Format | Detected from the URL | Content |
| --- | --- | --- |
| Telepy JSON | Any other URL | The full JSON below |
| Slack-compatible | `hooks.slack.com` | `{"text"}`, with `& < >` escaped (Mattermost and Rocket.Chat accept it too) |
| Discord | `discord.com/api/webhooks/…` | `{"content", "allowed_mentions": {"parse": []}}` |
| Google Chat | `chat.googleapis.com` | `{"text"}`, with the `<…>` syntax neutralised |
| Microsoft Teams | `*.logic.azure.com`, `*.webhook.office.com`, `*.powerplatform.com` | An Adaptive Card (Workflows' "When a webhook request is received") |
| Telegram | `api.telegram.org` | `{"text"}`; `chat_id` goes in the URL (`…/sendMessage?chat_id=…`) |
| ntfy | `ntfy.sh`, `ntfy.*` | Plain text; `title` / `tags` / `priority` / `click` are added as URL parameters |

Names and commands are text that users typed, so every format neutralises mentions such as `@everyone` / `<!channel>`.

Telepy JSON:

```json
{
  "id": "msg_…",
  "event": "tunnel.ip_changed",
  "title": "New device IP address",
  "severity": "warning",
  "at": "2026-10-26T12:00:00Z",
  "text": "[Telepy] office-pi connected from a new IP address: 203.0.113.9 (was 198.51.100.1)",
  "server": "https://telepy.example.com",
  "url": "https://telepy.example.com/tunnels/logs?tunnel=4",
  "tunnel": { "id": 4, "name": "office-pi", "reverse_port": 1025 },
  "data": { "ip": "203.0.113.9", "previous_ip": "198.51.100.1" }
}
```

`tunnel` is present only for events about a tunnel; `data` depends on the event (`by`, `command`, `reason`…; see the fields used in `webhooks/text.rs`).
The link uses `PUBLIC_URL` (or `https://SERVER_DOMAIN` if unset; with neither, no link is included).

## Custom headers

Up to 10 per webhook, for example your own service's `Authorization` or an ntfy access token. Names must be HTTP tokens and unique;
the ones Telepy sets itself (`content-type`, `user-agent`, `webhook-*`, `x-telepy-event`, `host`, `content-length`…) cannot be changed;
values are 1–2048 visible ASCII characters (no line breaks). They are stored encrypted with a key derived from `SECRET_KEY` (AAD `telepy-webhook-headers:<id>`),
and the API returns them only to people who can manage that webhook; a `PATCH` with `headers` replaces the whole set, and without it nothing changes. After `SECRET_KEY` is replaced they cannot be read:
deliveries fail with an explanation, and the edit screen asks you to enter them again (`headers_unreadable`).

## Signing (Standard Webhooks)

Every request carries:

- `webhook-id`: the message id, unchanged across retries (use it to de-duplicate)
- `webhook-timestamp`: the Unix seconds of this attempt (reject old ones to prevent replay)
- `webhook-signature`: `v1,` + base64(HMAC-SHA256(key, `{id}.{timestamp}.{body}`)), where key = the bytes you get by base64-decoding what follows `whsec_` in the secret
- `x-telepy-event`: the event name

View, copy or rotate the secret under "Signing secret" in the card menu; it is stored encrypted with a key derived from `SECRET_KEY` (the AAD is bound to the webhook id), and after `SECRET_KEY`
is replaced it can no longer be read, so rotate to a new one. Any Standard Webhooks library can verify it; the dialog has Node.js / Python examples.

## Delivery, retries, pausing

- Failures (connection errors, timeouts, 408, 429, 5xx) are retried once after 10 seconds and once after 1 minute; other 4xx are not retried; 3xx are not followed (enter the final URL).
- At most 30 messages per webhook per minute; the rest are skipped, and the first skip is recorded as `skipped`.
- After 20 failures in a row the webhook is paused (`paused_reason = failing`) and the owner is notified (for site-wide webhooks, every admin; `WEBHOOK-PAUSED`); turning it back on clears the pause.
- Each webhook keeps its latest 50 deliveries (with the body, up to 16 KB) for 30 days. A delivery is recorded as `sending` before it goes out and completed afterwards;
  if the backend restarted while a retry was still waiting, startup marks it failed ("Telepy restarted before this was delivered.").
- **Resend**: failed / skipped deliveries in the delivery history (delivered ones too, once expanded) have a "Resend" button: same `webhook-id`, rebuilt with the webhook's current format / language / headers,
  no retries, not counted towards consecutive failures, works on a disabled webhook, and is recorded as a new entry (`redelivered_from`). The event itself is stored in `event_json`; test sends cannot be resent.
- Creating / editing (including mode changes) / deleting a site-wide webhook and rotating its secret are recorded as `webhook` gateway events (the audit log in the admin section); opting out and cancelling an opt-out are recorded in
  that tunnel's Logs (`webhook_optout`).

## Address check (SSRF)

The URL of a personal webhook can be filled in by anyone and the server connects to it, so by default only public addresses are allowed: on save the host name is resolved, and if any address falls in a
private / localhost / link-local (including cloud metadata 169.254.169.254) / CGNAT / reserved range, or is an IPv6 address wrapping such an IPv4 (mapped, NAT64, 6to4),
it is refused (`private_target`); at delivery time the connection goes through a DNS resolver that returns public addresses only (against DNS rebinding), IP literals are checked separately,
redirects are not followed and proxies from environment variables are not used. Only when an admin turns on `notify_private_targets` are they allowed; site-wide webhooks are always allowed.

## API

| | |
| --- | --- |
| `GET /api/webhooks` | Mine, (admins) the full site-wide data, `site_summary` (for everyone: a summary of the site-wide webhooks, including `mode`, `my_optout` and `managed`, the covered tunnels I manage), the event catalogue for both scopes, `policy` |
| `POST /api/webhooks` | `{scope?, name?, url, format?, language?, events?, all_tunnels?, tunnel_ids?, delay?, enabled?, headers?, mode?}` → `{webhook, secret}`; `mode` = `default` / `enforced`, meaningful for site-wide only |
| `GET / PATCH / DELETE /api/webhooks/{id}` | Only your own (site-wide: admins); anyone else's is always 404 |
| `POST /api/webhooks/{id}/test` | Sends `webhook.test` and waits for the result (no retries, not counted towards consecutive failures) |
| `GET /api/webhooks/{id}/deliveries` | The latest 50 |
| `POST /api/webhooks/{id}/deliveries/{delivery_id}/redeliver` | Resend one (409 `not_redeliverable`: test sends) |
| `GET / POST /api/webhooks/{id}/secret` | Read / rotate the signing secret |
| `PUT /api/webhooks/{id}/optout` | `{tunnel_ids}`: replaces **my** opt-outs as a whole (only tunnels I manage that this site-wide webhook covers) and returns my summary; enforced mode is 400 `enforced`, a personal webhook is 404 |
| `DELETE /api/webhooks/{id}/optout` | Clears my opt-outs |

Errors are `{field: [message], code}` or `{error, code}`; `code`: `private_target`, `invalid_url`, `unresolvable`, `no_events`,
`no_tunnels`, `limit`, `personal_disabled`, `admins_only`, `secret_unreadable`, `bad_header`, `not_redeliverable`, `enforced`,
`not_manager` (not the owner / ADMIN of that tunnel), `not_covered` (this webhook does not cover that tunnel). The site-wide webhooks that admins receive also carry
`optouts [{tunnel_id, tunnel_name, by, at, active}]`.
For admins, `GET /api/webhooks` also returns `site_tunnels` (every tunnel on the server, for picking in a site-wide webhook).
