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

## Linking your existing account

Anyone can link their own account in **Preferences → Security → Single sign-on**:

1. Press **Link** next to the provider. If your account has two-step sign-in, confirm it's you first.
2. Sign in at the provider. You come back to a page that says the account is linked.

From then on the provider's button signs you in to that account. **Unlink** removes the link, after the same confirmation. Telepy won't let you unlink your last way in: keep a password, a passkey, or another link first.

## The command line

`telepy login` signs in through the browser. When the browser isn't signed in to Telepy yet, its sign-in page shows the same single sign-on buttons, so the CLI works with single sign-on without any extra setup.

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

For anything else, run **Test sign-in** first. It shows exactly what the provider sent.

## Not yet

Telepy reads who someone is, not what they belong to. Group-to-role mapping, signing out of the provider when you sign out of Telepy, and SCIM provisioning aren't there yet. Give people their tunnels and features the usual way.
