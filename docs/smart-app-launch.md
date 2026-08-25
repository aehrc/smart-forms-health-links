# SMART App Launch

**Status:** implemented in
[smart-forms-health-links](https://github.com/aehrc/smart-forms-health-links) — **on in the shipped
config, off in the fallback.**
**Audience:** anyone deploying this app against a real EHR, or changing the code that touches an
access token.

This app was built to work with no identity at all. That is not an oversight to be corrected: the
whole design turns on a filler being able to complete a form with no account, no login, and no
network path to the requester's servers. SMART App Launch does not change that — it is enabled in the
shipped config, but a session is still something the app runs *without* whenever there isn't one. It adds a session to
the *requester's* half of the app, and leaves the filler's half exactly as it was.

Everything below is about which half is which, and what must never cross between them.

## What a launch changes

| | Without a launch | With a launch |
| --- | --- | --- |
| EHR base URL | `responseServerUrl` from `config.json` | The launched server |
| EHR requests | Anonymous | `Authorization: Bearer …` |
| Who amended a response | A name typed into a box | `Practitioner/…`, vouched for by the authorisation server |
| Who a request is from | `senderName` from `config.json` | The launched user |
| Patient on a new request | Searched for | Already filled in, from the chart |

Nothing else moves. In particular the forms catalogue, the SHL payload host and the one-shot write
slot stay exactly where they were, and stay anonymous.

## The boundary

Three modules talk to servers that a *filler* reaches, and none of them may ever see a token:

| Module | Who fetches it | Why it must stay anonymous |
| --- | --- | --- |
| `src/fhir/formsServer.ts` | Both halves | A public read-only catalogue on a different host |
| `src/fhir/blobStore.ts` | The filler | Untrusted by design — the payload is a JWE and the key is in the link |
| `src/link/writeSlot.ts` | The filler | The caller is on another device and holds no credentials |

Two talk to the EHR, and those are the ones a session authorises:

- `src/fhir/ehrServer.ts` — patient, response and task searches
- `src/fhir/submit.ts` — `createResource`, `referenceResolves`, `publishRequestTask`

If a token reaches the first group, the app has stopped being the thing it claims to be. A minted
link would only work for the person who minted it.

### The token is gated on origin, not on "is there a session"

This is the part worth reading twice.

`resolveDestinations` in `src/fhir/submit.ts` reads write targets from a downloaded Questionnaire's
`sdc-questionnaire-endpoint` extension, and those **outrank configuration**. So a Questionnaire
fetched from a public catalogue can name any server on the internet as the place its responses go.

Attaching the bearer to whatever that returns would hand an EHR access token to a host chosen by
whoever authored the form. So `authedFetch` compares the request's origin against the session's own
`serverUrl` and attaches the token only on a match:

```ts
if (!session || !isLaunchedServer(url, session.serverUrl)) {
  return fetch(url, init);
}
```

Origin, not prefix. A prefix test on the base URL would accept
`https://ehr.example.org.attacker.test/fhir`; comparing whole base paths would reject the server's
own absolute pagination links, which are legitimate. A malformed URL is not a match — failing closed
costs an unauthenticated request the caller already handles, and failing open costs the token.

`authedFetch` also never overwrites an `Authorization` header the caller already set. `writeSlot.ts`
sets its own one-shot write token, which is a different capability with a different meaning.

## The flow

Both launch patterns are the same route. An EHR launch arrives with parameters; a standalone launch
is the same URL without them.

```
EHR launch         /launch?iss=https://ehr.example.org/fhir&launch=xyz
Standalone launch  /launch
                          |
                          v
       fhirclient discovers .well-known/smart-configuration
                          |
                          v
       redirect to authorization_endpoint, PKCE S256, state
                          |
                          v
       /callback?code=…&state=…   ->  token exchange  ->  session
```

- **`redirect_uri` is `/callback`**, and it must be registered with the authorisation server exactly.
  Both paths are constants in `src/auth/routes.ts` rather than literals, because a mismatch fails on
  the server's own error page and never reaches this app.
- **PKCE is `required`**, not the library default of `ifSupported`. A public client holds no secret,
  so PKCE is the only thing binding the authorisation code to this app.
- **`iss` is checked, not trusted.** It arrives in a query string a stranger can write. `issMatch` is
  set to the configured issuer, so an `iss` pointing somewhere else is refused rather than followed.
- **Tokens live in `sessionStorage`.** Per-tab, so two tabs launched from different patients do not
  share a context, and out of `localStorage`, which holds channel-C reply keys that must survive a tab
  closing — the opposite lifetime to an access token.
- **The code is exchanged exactly once.** An authorisation code is single-use, and React StrictMode
  runs effects twice in development, so `Callback` guards with a ref.

## Configuration

```jsonc
{
  "enableSmartLaunch": true,
  "smartIssuerUrl": "https://proxy.smartforms.io/v/r4/fhir",
  "smartClientId": "smart-forms-health-links",
  "smartScopes": null            // null takes DEFAULT_SMART_SCOPES
}
```

`canUseSmartLaunch()` returns true only when the flag is on *and* an issuer and client id are both
set — the same guard `canUseEncryptedReply` and `canUseOneShotWrite` use, so a deployment whose config
failed to load cannot start a flow whatever a future default does to the flag.

### The issuer is not the FHIR base you already have

The single most common way to get this wrong. `smartIssuerUrl` must be a base that actually serves
`.well-known/smart-configuration`:

```
https://proxy.smartforms.io/fhir/.well-known/smart-configuration
  -> 404, HAPI-0302: Unknown resource type '.well-known'

https://proxy.smartforms.io/v/r4/fhir/.well-known/smart-configuration
  -> 200, a real discovery document
```

Same data, same server, different facade — the second is
[smart-launcher-v2](https://github.com/aehrc/smart-launcher-v2). `npm run check:smart` asserts this,
and calls out the OperationOutcome case specifically, because a plain FHIR server does not 404 that
path: it parses `.well-known` as a resource type and returns a 200-shaped error that a naive check
reads as success.

### Standalone launch against smart-launcher-v2 needs a `/sim/` issuer

Found by testing, and it costs an afternoon if you do not know it. smart-launcher-v2 encodes its
launch options either in the `launch` parameter or in the issuer path, and it tries to parse them
either way:

| Launch | Issuer | Result |
| --- | --- | --- |
| EHR (`?iss=…&launch=…`) | `…/v/r4/fhir` | works — the options ride in `launch` |
| Standalone (`/launch`) | `…/v/r4/fhir` | **`invalid_request: Invalid launch options: SyntaxError: Unexpected end of JSON input`** |
| Standalone (`/launch`) | `…/v/r4/sim/{base64url-json}/fhir` | works |

With no `launch` parameter and no options in the path there is nothing to parse, and an empty string
is not valid JSON. Both `launch.smarthealthit.org` and `proxy.smartforms.io` behave identically, so
this is the launcher's own behaviour and not a deployment fault. The options are a base64url-encoded
JSON object — `{"launch_type":"provider-standalone","patient":"","provider":"", …}`.

This is a quirk of the *launcher*, not of SMART. A real EHR advertises one issuer that serves both
patterns.

> **The CSIRO sandbox cannot complete an interactive launch.** `proxy.smartforms.io` serves the
> discovery document and the auth endpoints, but its `/provider-login` and `/select-patient` routes
> return "this route does not exist". Use `launch.smarthealthit.org` to demonstrate a full login.

### Scopes

```
launch openid fhirUser online_access
user/Patient.crs user/QuestionnaireResponse.crs user/Task.crs user/Provenance.cr
```

- **`user/`, not `patient/`.** `/patients` and `/responses` search across the server. A `patient/`
  grant is scoped to the one patient in context and would leave both routes empty.
- **The permission letters track what the code issues.** It creates, reads and searches. It never
  updates or deletes on the EHR — the only `PUT` in the app is to a one-shot write slot, which is on
  the transport tier and unauthenticated.
- **`online_access`, not `offline_access`.** A foreground clinician tool with no backend has nowhere
  safe to keep a refresh token that outlives the session. Note that smart-launcher-v2 does not
  advertise `online_access`; `check:smart` reports that as advisory rather than failing, because
  `scopes_supported` is optional and servers routinely grant scopes they do not enumerate.
- **`launch` becomes `launch/patient` on a standalone launch**, where there is no EHR context to
  inherit and the authorisation server has to ask who the patient is.

## Precedence

Where a response is written, highest first:

1. The Questionnaire's own `sdc-questionnaire-endpoint` — the form's author saying where its answers
   belong.
2. **The launched server** — the EHR saying which record this clinician is working in, backed by a
   token.
3. `responseServerUrl` — whoever deployed the app, saying so once.
4. Nothing. The app refuses to write and says why.

A launch outranks configuration because it is the one that knows. It still loses to the
Questionnaire, which is unchanged behaviour.

`blobServerUrl` and `writeSlotServerUrl` are **not** part of this. In the shipped `config.json` they
happen to be the same string as `responseServerUrl`, which makes this easy to get wrong — but they are
transport, reachable by a filler holding no credentials, and moving them onto an authenticated server
would mint links that only their author can open.

## What this does not do

- **No confidential client, and no backend.** This is a static site; it can hold no secret. A
  confidential variant with a Fastify backend-for-frontend was prototyped in
  [PR #5](https://github.com/aehrc/smart-forms-health-links/pull/5) and closed unmerged — worth
  reading if a deployment needs one.
- **No token binding to an invitation.** The session authorises the clinician, not the link.
- **No launch required.** Every requester surface still works unauthenticated, and the filler's half
  is untouched. A launch is an upgrade, not a gate.
