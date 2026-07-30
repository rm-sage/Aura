# OAuth loopback contract (Aura desktop ⇄ aura.animasec.dev proxy)

Aura now runs the Trakt / AniList authorization leg in the user's **default
browser** rather than an in-app webview, because the default browser already
holds the user's provider session — that is the entire UX win. This is the
approach RFC 8252 ("OAuth 2.0 for Native Apps") recommends for native clients.

Trakt needed no proxy change (device flow has no redirect). **AniList does.**
This document is the contract the proxy must implement.

---

## Why not just keep redirecting to `aura://`

Browsers deliberately refuse to *auto*-redirect into a foreign protocol
handler; Firefox is the canonical case, and it fails silently. That is what
pushed Aura into an in-app webview in the first place (see the comment above
`open_oauth_popup_webview` in `src-tauri/src/scrobble_auth.rs`).

RFC 8252 §7.3's loopback redirect sidesteps it: `http://127.0.0.1:<port>/…`
is ordinary HTTP, so no browser blocks it, no OS scheme handler is consulted,
and no second `aura.exe` can be spawned by the scheme handler.

Aura already runs a loopback `axum` listener on **11471** for stream proxying,
so the landing pad costs nothing new — `src-tauri/src/oauth_callback.rs` just
adds one route to it.

---

## Request: `/oauth/{service}/start`

Aura calls the existing start endpoint with three **new, optional** params:

```
GET https://aura.animasec.dev/oauth/anilist/start
      ?redirect=loopback
      &port=11471
      &nonce=<uuid-v4>
```

| Param      | Required        | Meaning |
|------------|-----------------|---------|
| `redirect` | no              | `loopback` selects the new behaviour. Absent or any other value ⇒ **current behaviour, unchanged**. |
| `port`     | when loopback   | Aura's bridge port. Passed rather than hardcoded so changing `BRIDGE_PORT` never needs a proxy redeploy. |
| `nonce`    | when loopback   | Single-use v4 UUID minted by Aura. Must be echoed back verbatim on the final redirect. |

**Backward compatibility is required.** Aura still requests the legacy
`aura://` form (no params) for its in-app popup fallback — see
`scrobble_oauth_authorize_url(service, loopback)` in `scrobble_auth.rs`. Both
shapes must keep working indefinitely.

Store `port` + `nonce` alongside the CSRF `state` the proxy already generates
for this flow. Nothing else about state handling changes.

### Validation (do not skip)

```go
// Reject anything that isn't a plausible loopback port.
port, err := strconv.Atoi(q.Get("port"))
if err != nil || port < 1024 || port > 65535 {
    http.Error(w, "bad port", http.StatusBadRequest); return
}
// Nonce is opaque to the proxy, but bound it so it can't be used to smuggle
// junk into a redirect header.
if !regexp.MustCompile(`^[0-9a-fA-F-]{36}$`).MatchString(q.Get("nonce")) {
    http.Error(w, "bad nonce", http.StatusBadRequest); return
}
```

**The host MUST be hardcoded to `127.0.0.1`.** Never accept a host, scheme, or
full redirect URL from the query string — that turns the proxy into an open
redirect and hands an attacker a way to exfiltrate the token. Only the *port*
is caller-supplied, and only after the bounds check above.

---

## Response: the final redirect

Where the proxy currently does:

```go
http.Redirect(w, r, "aura://oauth/anilist?token="+tok+"&expires="+exp+"&user="+user, 302)
```

…it must, **when this flow was started with `redirect=loopback`**, instead do:

```go
u := url.URL{
    Scheme: "http",
    Host:   "127.0.0.1:" + strconv.Itoa(savedPort),
    Path:   "/oauth/callback",
}
q := url.Values{}
q.Set("nonce", savedNonce)   // REQUIRED — Aura rejects the callback without it
q.Set("token", accessToken)
if refreshToken != "" { q.Set("refresh", refreshToken) }
if expiresAt   != 0  { q.Set("expires", strconv.FormatInt(expiresAt, 10)) }
if username    != "" { q.Set("user", username) }
u.RawQuery = q.Encode()
http.Redirect(w, r, u.String(), http.StatusFound)
```

Param names are identical to the existing `aura://` contract (`token`,
`refresh`, `expires`, `user`) because Aura rebuilds the deep-link URL from
them and feeds it through the *same* `deep-link` handler in `App.tsx`. There
is no second token-persistence path to keep in sync.

### Failure / denial

If the user declines, or the code exchange fails, redirect to the same
callback with **only** `nonce` and no `token`. Aura renders "Authorization was
not completed" and clears its pending state, instead of hanging until its
2-minute timeout.

---

## What Aura does on receipt

`oauth_callback.rs::handle`:

1. Redeems the nonce. Unknown, expired (>15 min), or replayed ⇒ **400, token
   discarded, warning logged.** The service is taken from Aura's own minted
   record, never from the query string, so a callback cannot claim to be for a
   provider the user never started.
2. Missing/empty `token` ⇒ 400 with the "not completed" page.
3. Otherwise rebuilds `aura://oauth/<service>?token=…` and emits it on the
   existing `deep-link` channel, then focuses the main window.
4. Returns a small self-contained "You're connected" page (no external
   resources) that attempts `window.close()`.

The nonce is the whole access control: any local process can hit
`http://127.0.0.1:11471/oauth/callback`, so without it a malicious page could
plant an attacker-controlled token and silently redirect the user's scrobbles
into someone else's account.

---

## Unrelated bug worth fixing in the same pass

`/oauth/trakt/device/token` augments Trakt's response with `expires_at`, which
Aura stores and `summarise()` (`scrobble_auth.rs`) renders from directly.

Verify it is an **absolute Unix timestamp in seconds**, not Trakt's
`expires_in` duration (~7776000). If the duration leaks through, `expires_at`
lands in 1970, the Settings row shows a permanent red "expired, reconnect now",
and the user re-authorizes repeatedly **even though scrobbling keeps working** —
because `refresh_trakt_token` only ever fires reactively on a 401
(`scrobble.rs:673`, `:760`), never proactively.

Symptom to match against: `Trakt /sync/history OK (status=201)` in the logs
right up until a manual reconnect.
