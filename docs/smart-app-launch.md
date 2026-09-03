# SMART App Launch

**Status:** implemented in
[smart-forms-health-links](https://github.com/aehrc/smart-forms-health-links) — **on in the shipped
config, off in the fallback.**
**Audience:** anyone deploying this app against a real EHR, or changing the code that touches an
access token.

This app was built to work with no identity at all. Half of that is not an oversight to be corrected:
the whole design turns on a filler being able to complete a form with no account, no login, and no
network path to the requester's servers. SMART App Launch does not change that, and must not.

The other half was a mistake, and this is the document where it gets corrected. The same
no-identity-needed posture had leaked into the _requester's_ side, where an unlaunched visitor could
mint invitations, file answers into a record, amend somebody else's response, register a patient and
write back extracted resources — anonymously, against a server named in a config file. It worked only
because the default sandbox does not care.

So a launch is now **required to write, and optional to read**. The requester's half is read-only
without one: it still lists patients, responses and sent requests anonymously, and refuses every write.
The filler's half is untouched.

Everything below is about which half is which, and what must never cross between them.

## What a launch changes

|                                 | Without a launch                       | With a launch                                             |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| **Writing anything to the EHR** | **Refused**                            | Permitted                                                 |
| Reading the EHR                 | Anonymous, and still works             | `Authorization: Bearer …`                                 |
| EHR base URL                    | `responseServerUrl` from `config.json` | The launched server                                       |
| Who amended a response          | —                                      | `Practitioner/…`, vouched for by the authorisation server |
| Who a request is from           | —                                      | The launched user                                         |
| Patient on a new request        | —                                      | Already filled in, from the chart                         |

The last three rows used to say "a name typed into a box", "`senderName` from `config.json`" and
"searched for". Those were the answers when an unlaunched requester could write; the refusal in the
first row is what replaced them.

Nothing else moves. In particular the forms catalogue, the SHL payload host and the one-shot write
slot stay exactly where they were, and stay anonymous.

## What a launch gates

Two predicates in `src/lib/config.ts`, siblings of the `canUse…` family already there:

|                                           | Asks for                             | Enforced at                                                |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `canWriteToRecord(session, ehrServerUrl)` | A session **and** somewhere to write | `ReviewResponse` (accept, write-back), `CreatePatientForm` |
| `canMintRequest(session)`                 | A session, and nothing else          | `RequestForm`                                              |

`canMintRequest` asks for no destination, which looks like an oversight and is not. With
`publishRequestTasks` off, minting touches the EHR not at all — the payload goes to the blob host,
which is untrusted by design. It is gated on the _other_ thing a launch supplies: an invitation says
who it is from, and `senderName` is one string in a config file, identical on every request the
deployment has ever sent. The filler is being asked to hand over health information on the strength of
that name.

### The check is in the UI, and that is deliberate

Not in `src/fhir/submit.ts`, which is where it would belong if the question were only "may this
process write". Three reasons, and the first is the one that matters:

- **`resolveDestinations` also serves the filler.** With `enableServerReturn` on, the invitation itself
  tells a filler to `POST` answers to the endpoint the Questionnaire declares. A check in the fhir
  layer would refuse the person holding a link — the exact party this architecture exists to serve.
- **The check harness drives `submit.ts` directly.** `check:e2e-shl`, `check:amend`, `check:patient`
  and `check:writeback` all write without a session, and they still pass unchanged. That they do is the
  evidence the gate landed in the right place.
- **`authedFetch` owns the other boundary.** It answers "may this token go _there_", by origin. Keeping
  "may this visitor write at all" out of it keeps that file about one question.

### What is not gated

Reads. `/patients`, `/responses` and `/requests` list anonymously exactly as they did, so a deployment
pointed at a public sandbox is still browsable with no setup at all. `useEhrServerUrl` keeps its
`?? responseServerUrl` fallback.

Amendment has no check of its own, because it cannot be reached without one: `amendTargets` comes from
a write `ReviewResponse` has already performed, so `canWriteToRecord` was satisfied before the button
existed. `ReviewResponse.tsx` says so at `canAmend`, because seeding `results` from a prop would
quietly break that chain.

### Coming back afterwards

A gate offers a launch in place rather than redirecting to one — a screen that silently bounces
somebody to a login has hidden the reason, and against a misconfigured issuer it bounces them into a
loop. The intended path is remembered in `src/auth/returnTo.ts` and consumed by `Callback`, so a launch
started from `/request/abc` returns there rather than to the form list.

It travels in `sessionStorage` rather than through the flow, because `redirect_uri` is registered
exactly and `redirectUri` strips the query and fragment on purpose. It is validated on the way out even
though only this app writes it: `//evil.example/x` is a valid protocol-relative URL, and handing one to
`navigate` would turn "come back here" into an open redirect. `check:roundtrip` asserts that.

### Seeing what is set

`src/components/LaunchContextBar.tsx` renders under the nav on every route: the launched user, the
patient in context, the server being written to, and — with no session — the fact that the app is
reading anonymously and read-only. It replaced `SessionBadge`, which said the same thing in fewer words
from inside a nav row that had run out of width.

Unlike `ScopeWarning` below it, the strip renders in every state including the empty one. "No session"
is not an absence here, it is a fact about what the next click can do.

## The boundary

Three modules talk to servers that a _filler_ reaches, and none of them may ever see a token:

| Module                    | Who fetches it | Why it must stay anonymous                                            |
| ------------------------- | -------------- | --------------------------------------------------------------------- |
| `src/fhir/formsServer.ts` | Both halves    | A public read-only catalogue on a different host                      |
| `src/fhir/blobStore.ts`   | The filler     | Untrusted by design — the payload is a JWE and the key is in the link |
| `src/link/writeSlot.ts`   | The filler     | The caller is on another device and holds no credentials              |

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
  "smartScopes": null, // null takes DEFAULT_SMART_SCOPES
}
```

`canUseSmartLaunch()` returns true only when the flag is on _and_ an issuer and client id are both
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

smart-launcher-v2 reads its launch options from the `launch` parameter on an EHR launch, or from the
issuer path on a standalone launch, and it parses them either way:

| Launch                  | Issuer                              | Result                                                                                   |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| EHR (`?iss=…&launch=…`) | `…/v/r4/fhir`                       | works — the options ride in `launch`                                                     |
| Standalone (`/launch`)  | `…/v/r4/fhir`                       | **`invalid_request: Invalid launch options: SyntaxError: Unexpected end of JSON input`** |
| Standalone (`/launch`)  | `…/v/r4/sim/{base64url-array}/fhir` | works                                                                                    |

With no `launch` parameter and no options in the path there is nothing to parse, and an empty string
is not valid JSON. Both `launch.smarthealthit.org` and `proxy.smartforms.io` behave identically, so
this is the launcher's own behaviour and not a deployment fault.

The options are base64url of a JSON **array**, not an object. `src/isomorphic/codec.ts` maps them by
position — `[launchTypeIndex, patient, provider, encounter, skip_login, skip_auth, sim_ehr, scope,
redirect_uris, client_id, client_secret, auth_error, jwks_url, jwks, clientTypeIndex, pkceIndex,
fhir_context]`, where `2` is `provider-standalone`. An object is accepted as well, but it falls to
`decodeLegacy`, which reads single-letter keys (`h`, `b`, `e`, `i`, `j`), so
`{"launch_type":"provider-standalone", …}` decodes as an EHR launch with nothing selected and lands
on the login screen — which is exactly the wrong lesson to draw from it.

> **The CSIRO sandbox serves no launcher UI.** The AEHRC fork drops the two lines that serve the
> React build — upstream `backend/index.ts:25` (`express.static`) and `:96` (the `index.html`
> fallback) — and its catch-all, `backend/index.ts:123-128`, answers every unmatched path with "This
> service is healthy, but this route does not exist". Each screen the authorisation server redirects
> to (`/provider-login`, `/select-patient`, `/authorize-app`) therefore dead-ends there.
>
> A launch that needs no screen still completes: pin `provider` and `patient`, set `skip_login` and
> `skip_auth`, and `/auth/authorize` redirects straight back to `redirect_uri` with a code. The
> patient has to be pinned because `buildScopes` always asks for `launch/patient` on a standalone
> launch and `needToPickPatient` (`backend/routes/auth/authorize.ts:230-241`) turns that into a
> picker. This is what `deploy/demo/values.yaml` uses. Point at `launch.smarthealthit.org` instead
> when the point is to show the login and patient-picker screens.

### Scopes

```
launch openid fhirUser online_access
user/Patient.crs user/QuestionnaireResponse.crs user/Task.crs user/Provenance.cr
user/Practitioner.r
user/Condition.crus user/Observation.crus user/AllergyIntolerance.crus
user/MedicationStatement.crus user/Immunization.crus user/Procedure.crus
user/Encounter.crus
user/MedicationRequest.rs user/ServiceRequest.rs user/PractitionerRole.rs
user/Organization.rs user/Device.rs
```

Twenty-one scopes, with `enablePrePopulate` on as it is in the shipped config and in
`deploy/demo/values.yaml`. With it off the read-only block goes away and the `.crus` block drops to
`.cu` — the shorter list this section used to print, and the one the demo deployment was really asking
for while the key was missing from its values.

**A client registration must allow `launch/patient` too**, even though it never appears alongside
`launch` in a single request — see the last bullet. Registering only what one launch pattern asks for
is the mistake that costs an afternoon.

This list is generated by the app itself at `/launch/setup` — **Launch setup** in the context strip
under the nav, on every screen — which is the copy to trust: it reflects the deployment's own
`smartScopes` override, and a document cannot.

- **`user/`, not `patient/`.** `/patients` and `/responses` search across the server. A `patient/`
  grant is scoped to the one patient in context and would leave both routes empty.
- **The permission letters track what the code issues.** The resources the app authors are `crs` —
  create, read and search. The `u` appears only for [form data extraction](write-back.md), which
  emits `PUT` and `PATCH` entries: a form recording a resolved allergy is amending something that
  already exists, and there is no create-only way to say that.
- **`.crus` is two features asking for one permission.** Extraction wants `user/Condition.cu` and
  [pre-population](pre-population.md) wants `user/Condition.rs`, for opposite reasons, so
  `mergePermissions` collapses them into a single request rather than asking the same question twice.
  The five `.rs` scopes are the types pre-population reads and nothing writes.
- **Nothing is ever deleted, and the resources the app _authors_ are never updated.** No `d` on
  anything; no `u` on `Patient`, `QuestionnaireResponse`, `Task` or `Provenance`.
  [Amendments are new resources](../README.md#amendments-are-new-resources) is what makes that
  possible — a stored response never has to be edited in place. `check:roundtrip` asserts both halves.
- **A deployment whose forms declare no extraction can drop the `u`.** Set `smartScopes`, or
  `enableWriteBack: false` to remove the feature outright. `enablePrePopulate: false` drops the reads
  the same way. Both flags have to be stated in a deployment's own values — absent, they fall back to
  off, and the grant silently narrows with them. `check:roundtrip` asserts that
  `deploy/demo/values.yaml` states every key in `config.json` for exactly this reason.
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

**Level 3 is now unreachable from the app**, and it is worth being explicit about why rather than
letting a reader discover it. `resolveDestinations` falls to `responseServerUrl` only when there is no
session — and with no session the app will not write at all. So configuration still supplies the EHR
base the requester _reads_, and no longer supplies one it writes to. The level stays documented and
stays in the code because the Node check scripts pass no session and reach it, which is how the write
path is exercised offline from a launch.

A deployment that wants a configured write destination back has to want unattributable writes back with
it; that is the trade this gate exists to refuse.

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
- **No gate on reading.** A launch is required to write and optional to read, so an unlaunched
  requester still browses patients, responses and sent requests — anonymously, against
  `responseServerUrl`. Narrowing that further is a deployment's decision, not this app's: point
  `responseServerUrl` at nothing and there is nothing to read.
- **No gate on the filler, ever.** Somebody holding nothing but a link has no account to log into, and
  every channel that serves them stays anonymous. This is the constraint that decides where the write
  gate lives — see [What a launch gates](#what-a-launch-gates).
