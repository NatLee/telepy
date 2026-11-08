# Single sign-on (OIDC)

<p align="center"><b>English</b> | <a href="./sso.zh-TW.md">繁體中文</a> | <a href="./sso.ja.md">日本語</a></p>

Telepy can let people sign in with your organization's identity provider instead of a Telepy password. Okta, Microsoft Entra ID, Google Workspace, Keycloak, Authentik, Dex, and any other OpenID Connect provider that supports the authorization code flow with PKCE all work. Each provider you add gets its own button on the sign-in page: "Continue with Okta", and so on.

The password still works. So do passkeys, Google sign-in and Telepy's own two-step sign-in. Single sign-on is one more way in, not a replacement for the others, and nobody is forced to use it.

## What you need

- An administrator account on Telepy.
- Permission to register an application at your identity provider.
- `PUBLIC_URL` set to Telepy's address, for example `https://telepy.example.com` (Site settings → Server, or `.env`). Without it the callback address follows whatever address you happen to be browsing on, and your provider will refuse it the day that changes.

## Setting up a provider

### At the provider

1. Register a new **web application**. Some providers call it an OIDC client, an app registration, or a confidential client.
2. As the redirect URI, enter the callback address Telepy shows for this provider. It looks like `https://telepy.example.com/api/auth/oidc/okta/callback`, and the last part before `/callback` is the provider's slug in Telepy.
3. Allow the scopes `openid`, `email` and `profile`.
4. Copy the issuer URL, the client ID and the client secret.

A public client without a secret works too. Telepy then relies on PKCE alone, which providers accept but security reviewers enjoy discussing.

### In Telepy

1. Open **Site settings → Sign-in → Single sign-on (OIDC)** and choose **Add provider**.
2. Give it the name people will see on the button.
3. Paste the issuer URL and press **Check**. Telepy reads the provider's discovery document and its signing keys, and tells you what it found or why it can't use the address.
4. Register the callback address shown in the dialog at the provider, if you haven't already.
5. Fill in the client ID and secret, decide the account rules (next section), and save.
6. Press **Test sign-in**. You sign in at the provider once, and Telepy shows the claims it received and what it would do with them: which account it would sign in to, create, or refuse. Nobody is signed in or created by a test.
7. When the test looks right, switch the provider on. Its button appears on the sign-in page.

Tip: save a new provider switched off, test it, then switch it on. Tests work on providers that are switched off.

### Notes per provider

| Provider | Issuer URL | Worth knowing |
| --- | --- | --- |
| Okta | `https://<your-org>.okta.com` or `https://<your-org>.okta.com/oauth2/default` | Use the same one the app's sign-in policy belongs to |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant id>/v2.0` | `email` is often missing; choose **preferred_username** for usernames. Entra doesn't send `email_verified`, so linking by email never applies |
| Google Workspace | `https://accounts.google.com` | Google lets in *every* Google account. Always fill in **Allowed email domains** |
| Keycloak | `https://<host>/realms/<realm>` | |
| Authentik | `https://<host>/application/o/<app slug>/` | Keep the trailing slash exactly as Authentik shows it |
| Dex | The `issuer` from Dex's config | |

## Who gets in

When someone signs in with a provider, Telepy decides the account in this order:

1. **Linked before**: the same Telepy account as last time. Telepy finds it by the provider's stable user ID (`sub`), not by the email, which can change.
2. **Link by verified email** (off by default): an existing account with the same email, but only when the provider says the email is verified. Turn this on only for a provider your organization runs. Whoever controls an email address there gets the Telepy account with that address, administrators included.
3. **Create an account on first sign-in** (on by default): a new account named after the part of the email before the `@`, or after `preferred_username`. If that name is already taken, Telepy refuses rather than guess, and says so.
4. Otherwise nobody gets in. People link their existing account themselves (next section).

**Allowed email domains** (empty by default) applies to every sign-in through that provider, existing accounts included. Leave it empty when the provider only lets your own people in; fill it in when it lets in the whole world (Google, a multi-tenant Entra app).

A provider's "create an account" switch does not depend on the Registration switch above it. Registration covers password sign-ups and Google sign-in.

After the account is decided, the usual rules apply: a disabled account stays out, and an account with two-step sign-in is still asked for its passkey or code. Your provider's own MFA happens before that, at the provider. Yes, that can mean two MFA prompts; Telepy would rather ask twice than not at all.

## Groups and roles

Your provider already knows who is in which team. Telepy can use that, under **Groups and roles** in the provider's settings:

- **Only these groups may sign in**: people outside every listed group are turned away at this provider's button. Empty = anyone the provider lets in.
- **Group → Telepy role**: a provider group can make someone an **administrator**, or put them in a Telepy **organization group** (the ones on Users & access → Organization groups, whose feature rules decide who may use the terminal, files, the remote desktop and so on). Several rules may point at the same role; a person gets the roles of every group they are in.

The rules are applied every time someone signs in with that provider, and they follow a few rules of their own:

- Group names are matched exactly, capital letters included.
- Telepy only takes away what **this provider gave**. A membership or an admin right an administrator gave by hand stays, even when the person leaves the matching group at the provider.
- If the ID token carries no groups claim at all, it depends on the person. When the provider has given them something before, the claim is clearly set up, so its absence means they are in no group now (Keycloak and Entra ID leave the claim out when a person has no groups) and what the provider gave is taken away. When it never gave them anything, nothing changes: Telepy can't tell "in no group" from "not set up to send groups", and would rather not guess. An empty list always means "in no group".
- The last active administrator is never demoted, so the site can't end up with nobody in charge.
- The person's own Telepy two-step sign-in still runs after the roles are applied.

On Feature permissions, members and administrators that came from a provider are marked with a building icon. Removing one there lasts only until their next sign-in, so change the group at the provider instead. **Test sign-in** shows the groups the provider sent and what would change, before anything does.

### Sending groups from each provider

| Provider | Groups claim | What to set up |
| --- | --- | --- |
| Okta | `groups` | Add a groups claim to the app (or the authorization server) with a filter such as "starts with telepy-" |
| Microsoft Entra ID | `groups` or `roles` | `groups` sends object IDs, not names; app roles (`roles`) are usually easier to read |
| Google Workspace | | Google's ID token has no groups; use allowed email domains instead |
| Keycloak | `groups` or `realm_access.roles` | Add a Group Membership mapper (claim name `groups`, full path off), or use realm roles |
| Authentik | `groups` | Sent with the `profile` scope |
| Dex | `groups` | Add `groups` to the scopes |

## Sharing tunnels with a group

Groups can also open tunnels. On a tunnel's share dialog, the **Groups** tab shares it with a group, with a permission, the accounts members may log in as, and an optional end date, just like sharing with a person. Everyone in the group then has the tunnel, each with their own share, and that follows the group: people who join it get the tunnel, people who leave it lose it and their open sessions end. Because single sign-on rules and SCIM keep organization groups in step with your provider, an identity provider group ends up deciding who reaches which tunnel.

There are two kinds of group:

- **Organization groups** are kept by admins, single sign-on rules or SCIM, and carry feature rules. One shows up in share dialogs only after an admin turns on **Can be shared** on Users & access → Organization groups, so a group made for feature rules (contractors without the terminal, say) stays out of everyone's sight. Turning it off ends every tunnel share with that group. Before that, and before a member change or a delete, the page lists who would gain or lose which tunnels.
- **Personal groups** are made by anyone who may share tunnels, right in the **Groups** tab. Only their maker sees them, and they never change what anyone may use. A share with one counts only while its maker still owns the tunnel or holds Admin on it through their own share or an organization group. Otherwise the share is paused and its members get nothing through it until that changes, so losing Admin really ends what you shared.

- **Someone shared with directly keeps their own share.** The group never changes it. **Set this person on their own** turns a share that came through a group into their own.
- **Several groups add up.** Someone in two groups the tunnel is shared with gets the higher permission, every account of both, and the later end date.
- **Changes go through the group.** A share that came through a group can't be revoked, changed or left one person at a time: take the person out of the group, or change or stop the group's share. Access requests still work on top of it.
- Only the tunnel's owner and its Admins share with groups, as with people. Every change appears in the tunnel's **Logs**.

## Linking your existing account

Anyone can link their own account in **Preferences → Security → Single sign-on**:

1. Press **Link** next to the provider. If your account has two-step sign-in, confirm it's you first.
2. Sign in at the provider. You come back to a page that says the account is linked.

From then on the provider's button signs you in to that account. **Unlink** removes the link, after the same confirmation. Telepy won't let you unlink your last way in: keep a password, a passkey, or another link first.

## The command line

`telepy login` signs in through the browser. When the browser isn't signed in to Telepy yet, its sign-in page shows the same single sign-on buttons, so the CLI works with single sign-on without any extra setup.

## Signing out

By default, signing out of Telepy ends the Telepy sign-in only; the provider keeps its own session, so the next press of its button may go straight through. To end both, switch on **Also sign out at the provider when signing out of Telepy** in the provider's settings and register the **sign-out redirect URI** it shows (`https://<telepy>/login`) at the provider: Okta calls it a sign-out redirect URI, Keycloak a valid post logout redirect URI, Entra a redirect URI of the app.

When someone then presses Sign out, Telepy sends their browser to the provider's sign-out page with that sign-in's ID token as the hint, and the provider sends it back to Telepy's sign-in page. It only happens when the person signs out themselves: being signed out by an administrator, from another device or because the sign-in expired never takes anyone to the provider. A provider without a published sign-out endpoint (Google is one) can only be signed out of Telepy; the **Check** button shows whether yours has one.

## Accounts made by the provider (SCIM)

Without it, single sign-on creates an account the first time someone signs in. With SCIM the provider manages accounts ahead of that: it creates them, keeps names and emails current, switches people off when they leave, and keeps groups in step. Okta and Microsoft Entra ID both speak it.

To turn it on, open the provider in **Site settings → Sign-in → Single sign-on**, go to the **Provisioning (SCIM)** tab and press **Create token**. Copy the token right away: Telepy keeps only its hash and won't show it again. Then give the provider the base URL `https://<telepy>/api/scim/v2` and the token:

| Provider | Where | Base URL goes in | Token goes in |
| --- | --- | --- | --- |
| Okta | Your app → General → Provisioning: SCIM, then Provisioning → Integration | SCIM connector base URL (unique identifier field `userName`; tick push new users, profile updates and groups) | Authentication mode HTTP Header |
| Microsoft Entra ID | Enterprise application → Provisioning → Automatic | Tenant URL | Secret token |

What the provider can do:

- **Create accounts.** The username is the part of `userName` before the `@`, tidied the same way as single sign-on usernames. An account that already exists with that username is never taken over: the provider gets a conflict and you decide what to do.
- **Change accounts.** Name and email follow the provider.
- **Switch accounts off.** `active: false` does what disabling the account here does: web sign-ins and live sessions end, MCP agent sessions close, and the keys Telepy installed leave the devices. Switching it back on restores access. The last active admin is never switched off.
- **Delete accounts.** A delete switches the account off instead of removing it, so recordings, logs and tunnels stay. If the provider later creates the same person again, they get the same account back.
- **Push groups.** Each group becomes a Telepy organization group, the kind **Feature access** uses, with the members the provider sends. Like any new organization group, it is not open to sharing until an admin turns that on. People the provider didn't create are never taken out of those groups, a name that an existing Telepy group already has is refused, and a group the provider deletes is deleted here too.

When someone the provider created signs in through single sign-on for the first time, Telepy links that sign-in to their account (same email or username), whether or not linking by verified email is on.

Only an admin who confirmed it's them can make a token. **Replace token** stops the old one at once; **Turn off** stops provisioning but keeps every account and group it made. The token reaches `/api/scim/v2` and nothing else. The user list marks the accounts a provider manages; a change you make to one of them may be undone by the provider's next sync. Every account and group change appears in the admin **Audit log**.

## What Telepy checks

- **Each sign-in is bound to the browser that started it.** Telepy gives the browser an HttpOnly cookie at the start. A callback address opened in another browser, for example one someone sends you, signs nobody in.
- **Each provider has its own callback address**, so an answer meant for one provider can't be passed off as another's.
- **The ID token** must be signed with one of the provider's published keys (RSA, ECDSA or EdDSA; unsigned and HMAC tokens are never accepted) and carry the right issuer, audience, expiry and the nonce from this sign-in.
- **Everything is single use.** The state, the code and the ticket the browser gets at the end all work once, within minutes.
- The client secret is stored encrypted with `SECRET_KEY` and is never shown again after saving.

Every change to a provider and every link or unlink appears in the admin **Audit log**. Sign-ins appear in each person's sign-in history as "Single sign-on".

## When it doesn't work

| What the page says | Usually means |
| --- | --- |
| No Telepy account is linked to this sign-in yet | Creating accounts is off, and this person hasn't linked one. They sign in another way and link it, or you switch account creation on |
| A Telepy account with your username already exists | Someone already has that username. They sign in with it and link the provider |
| Accounts from that email domain can't sign in here | The email isn't in **Allowed email domains** |
| Finish signing in in the same browser you started in | The cookie was lost: another browser, a private window that closed, or cookies blocked for this site |
| Single sign-on didn't work | Most often the client secret, the redirect URI or the clock. The backend log says which (`[OIDC]` lines) |
| The sign-in provider refused the request | The provider's settings for Telepy: the redirect URI, the allowed scopes, or the app isn't assigned to this person |
| This sign-in option only lets in certain groups, and the provider sent no groups for you | **Only these groups may sign in** is set, but the ID token has no groups claim. Usually the person is in no groups (Keycloak and Entra ID then leave the claim out); otherwise check the claim name or the provider's groups setup |
| Your groups at the provider aren't allowed to sign in here | The person is in none of the listed groups |

For anything else, run **Test sign-in** first. It shows exactly what the provider sent.
