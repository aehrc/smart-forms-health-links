# Validating against Aidbox: the two-window walkthrough

**Author:** John Grimes

This is the manual demonstration of the confidential SMART app and its token-carrying health
links, run against a live Aidbox instance. It is written for somebody who did not build it: every
command is given in full, and every step says what to expect so that a step which does not do what
it says can be recognised as a failure rather than shrugged at.

Two windows, because that is the point of the feature. Window A is a clinician signed in to a
clinical system. Window B is a patient with a link and no account. Nothing crosses between them
except the link.

There are no screenshots. Everything below is either a command with its output or a specific piece
of on-screen text to look for, which is more use to a reader than an image of a browser.

## What you need

| Thing                    | Where it comes from                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Aidbox instance      | `https://sczsqtqcgi.aidbox.app`                                                                                                                                                                                                          |
| Operator API credentials | 1Password item **Smart Forms Health Links Aidbox Operator** (`username`, `password`) in the **Work Agent** vault. On a fresh instance this client does not exist yet - see [Creating the operator client](#creating-the-operator-client) |
| App secrets              | 1Password item **Smart Forms Health Links** in the **Work Agent** vault: `session cookie secret`, `launch client secret`, `backend private jwk`, `e2e user password`                                                                     |
| `.env`                   | Copy `.env.example`. It holds `op://` references, never values, and is gitignored                                                                                                                                                        |
| `config/issuers.json`    | Copy `config/issuers.example.json`. Secret-bearing fields hold `env:VARIABLE_NAME` references, resolved from the environment at load                                                                                                     |
| 1Password CLI            | `op` on the path, signed in (a service account token works)                                                                                                                                                                              |

`launch client secret` and `backend private jwk` are _created by the first setup run_, which prints
them once; leave them unset until then. `e2e user password` is **not** generated - it is input, and
the setup run fails without it, so choose one up front.

## Holding the secrets

Two routes. They differ only in how the values reach the process; nothing in the code reads `.env`
itself.

### Locally: real values in `.env`

`.env` is gitignored, and for a disposable instance this is enough. Put real values in it and load
it into the shell before running anything:

```bash
set -a; . ./.env; set +a
npm run setup:aidbox
```

`set -a` exports what the file defines, so any command after it inherits the values.

**Quote anything with punctuation.** `BACKEND_PRIVATE_JWK` is a line of JSON, and a base64 secret
can carry `/` and `=`; unquoted, the shell mangles both. Single quotes are safe because neither
value contains one:

```bash
BACKEND_PRIVATE_JWK='{"kty":"RSA",...}'
```

**Leave a credential you do not have yet commented out, not blank.** A variable set to the empty
string is treated as absent, but only since the fix that accompanied this note - an older build
parses `""` as JSON and fails with `Unexpected end of JSON input`.

### Shared or deployed: `op://` references

For anything beyond one machine, `.env` holds references and the values stay in 1Password:

```bash
op run --env-file .env -- npm run setup:aidbox
```

`op run` resolves each `op://vault/item/field` and passes the values to that one process, so no
secret is written to disk or left in a shell history. `.env.example` ships in this form. Never use
`op read` and never print a resolved value.

## Creating the operator client

`setup:aidbox` writes `Client`, `AccessPolicy` and FHIR resources, so it needs credentials that may
do all three. **A fresh Aidbox has none**, and this is the one step the script cannot do for itself:
it would need the very credentials it is creating. So it is done once, by hand, in the instance's
own REST console.

Sign in to the Aidbox console and open the REST console, then send these two. Choose a long random
secret - `openssl rand -base64 32` - and keep it; nothing recovers it afterwards.

```json
PUT /Client/sfl-operator

{
  "secret": "PASTE-A-LONG-RANDOM-SECRET",
  "grant_types": ["basic"]
}
```

```json
PUT /AccessPolicy/sfl-operator-policy

{
  "engine": "allow",
  "description": "Operator access for smart-forms-health-links setup",
  "link": [{ "resourceType": "Client", "id": "sfl-operator" }]
}
```

Three details, each of which produces a confusing failure if it is got wrong.

**The Aidbox endpoints, not the FHIR ones.** `Client` and `AccessPolicy` are Aidbox's own resources.
`POST /fhir/Client` reaches them through the FHIR API, which will not accept a client-assigned `id`
on a create - and the id is the whole point here, because it is half of the credential.

**`PUT` at a fixed id, not `POST`.** Same reason the setup script does: re-running it is then a
no-op rather than a second client.

**JSON, not YAML.** The console parses the body as JSON whatever `Content-Type` says, so a YAML body
comes back as `Unrecognized token 'id': was expecting (JSON String, Number, Array, Object...)`.

**`link` takes Aidbox references, not FHIR ones** - `{ "resourceType": "Client", "id": "..." }`,
not `{ "reference": "Client/..." }`. A FHIR-shaped link is accepted and silently matches nothing,
which reads as a working policy that authorises no one.

`engine: allow` is unrestricted, which is what setup needs and more than the app ever gets - the two
clients the script goes on to register are each held to a narrow `AccessPolicy`. Treat this one as an
operator credential: it belongs in 1Password, not in a shell history, and it is not referenced by
the running app at all.

Confirm it works before going further:

```bash
set -a; . ./.env; set +a
curl -s -o /dev/null -w "%{http_code}\n" \
  -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
  "$AIDBOX_BASE_URL/fhir/Patient?_count=1"
```

`200` means the client and its policy are both in place. `401` is the credentials, `403` is the
`AccessPolicy`.

## One-time setup

```bash
npm install
set -a; . ./.env; set +a       # or: op run --env-file .env --
npm run setup:aidbox
```

`ops/aidboxSetup.ts` writes, by `PUT` on a fixed id, so it is idempotent - safe to re-run, and the
right thing to run after wiping the instance. It registers:

- the confidential launch client `smart-forms-health-links` (authorization code, PKCE, secret
  required, `launch/patient` in scope);
- the Backend Services client `smart-forms-health-links-backend` (signed client assertion against
  the app's own JWKS, scoped to `system/QuestionnaireResponse.c`, `system/Task.r`,
  `system/Task.u`);
- an `AccessPolicy` for each, as narrow as Aidbox's `matcho` engine allows;
- the demo Questionnaires `AdultSepsisScreening` and `GPChronicConditionManagementPlan`, read from
  `fixtures/questionnaires/`;
- the demo patient `pt-demo` ("Jane Citizen"), the practitioner `prac-demo` ("Dr Alex Fielding")
  and the Aidbox `User` `e2e-demo` / `e2e-demo@example.org` the automated suite signs in as.

It also verifies CORS and reports which mode the instance is in. Read that line: a browser cannot
fetch a manifest from an instance that will not allow the app's origin.

The run prints the generated launch client secret and Backend Services private JWK **once**. Put
both into the 1Password item straight away; they are never logged again, and the only way to
recover them is to re-run setup, which mints new ones.

## Bringing the app up

The BFF serves the built SPA, so there is one origin and one cookie. `overmind` runs the build in
watch mode alongside the server:

```bash
op run --env-file .env -- overmind start
```

Or, without `overmind`:

```bash
npm run build
op run --env-file .env -- npx tsx server/index.ts
```

Either way the app is at `http://localhost:3000`, which is not negotiable for the demo: it is the
origin the launch client's `redirect_uri` and `launch_uri` are registered against. Pointing the app
somewhere else means re-running setup with a different `APP_ORIGIN`.

Check it is up and knows the issuer:

```bash
curl -s http://localhost:3000/api/issuers
```

Expect a one-element array naming `https://sczsqtqcgi.aidbox.app/fhir`. An empty array means
`ISSUER_REGISTRY_PATH` is pointing at a file that is not there.

### What this instance supports

Checked against `/fhir/.well-known/smart-configuration` on 3 September 2026, because the whole
architecture rests on two capabilities that not every SMART server has:

| Needed for                     | Capability                                                   | Present |
| ------------------------------ | ------------------------------------------------------------ | ------- |
| The confidential launch client | `client-confidential-symmetric`                              | yes     |
| Backend Services token minting | `client-confidential-asymmetric`, `private_key_jwt`, `RS384` | yes     |
| EHR and standalone launches    | `launch-ehr`, `launch-standalone`, `context-ehr-patient`     | yes     |
| `fhirUser` for attribution     | `sso-openid-connect`                                         | yes     |
| The grant's scopes             | `permission-v2`, `system/*.cruds`, `user/*.cruds`            | yes     |

FHIR `4.0.1`, with `Questionnaire`, `QuestionnaireResponse`, `Task`, `Patient`, `Practitioner` and
`Provenance` all present. **This is the second capability that matters**: the smart-launcher facade
the demo used before offers no Backend Services at all, which is why a link minted against it has no
grant to carry and every request falls back to the scan-back path.

## Scenario 1 - the full loop

This is the demonstration. Window A is an ordinary browser window; window B must be a **private**
window, because the point is that it has no session.

1. **Window A: sign in.** Open `http://localhost:3000/`. With no session the page offers "Sign in to
   a clinical system" and lists the registered servers - and the header shows nothing but the
   product name, because a signed-out visitor has no use for clinician navigation. Press **Sign in**
   next to `Aidbox demo`. Aidbox asks for the demo user's credentials, then for consent. Allow it.

   Expect: back at `/`, with the header now carrying **Patients**, **Responses**, **Sent requests**
   and **Scan**, and an identity chip reading `Aidbox demo` / `Dr Alex Fielding`. The page lists
   the questionnaires _Aidbox_ holds, under the heading "Questionnaires held by Aidbox demo". If
   that list is empty, setup has not run against this instance.

2. **Window A: mint an invitation.** Find "Adult Sepsis Primary Healthcare Screening Tool" and press
   **Request** beside it. On the mint screen, type `Citizen` into "Search the server you are signed
   in to" and choose the result whose second line reads `Patient/pt-demo` - the demo instance holds
   more than one Jane Citizen, and only that one is the demo patient. Press **Create request link**.

   Expect, after a few seconds: an alert headed "Published to the server" naming a
   `urn:uuid:…` reference, and below it a QR code and a `Link` box whose contents begin
   `http://localhost:3000/view#shlink:/`. Press **Copy link**, or select the box. **Sent
   requests** now lists the request as **Awaiting answers**, with its reference, its published
   `Task/<id>` and `Patient/pt-demo` - read back from the Task on Aidbox rather than from
   anything held in this browser, which is why it is visible from any browser.

   What just happened, in order: the request Task was published to Aidbox with the session's own
   authority; the whole questionnaire was encrypted and stored by this app's server; and the link
   was minted as a pointer plus a decryption key. No clinical content is in the QR code.

3. **Window B: open it with no account.** Paste the link into a private window.

   Expect: the form renders. No sign-in, no configuration, nothing to install. Above it, a
   disclosure headed "Answers go straight to sczsqtqcgi.aidbox.app", and below that the
   request names who asked ("Dr Alex Fielding has asked for this form to be completed"), who it is
   for ("Addressed to Jane Citizen") and the request reference. The header carries the product name
   and nothing else - no navigation this window could use.

4. **Window B: fill and send.** Answer some questions. "Age" takes a number; the six vital signs
   are deliberately read-only, because they come from the patient record rather than from whoever
   is answering. The Yes/No items are all editable.

   Press **Send answers to sczsqtqcgi.aidbox.app**. It does not send: it asks again, naming
   the host, because a send writes into a medical record and cannot be taken back. Press **Confirm
   and send**.

   Expect: "Accepted by sczsqtqcgi.aidbox.app", and the form and the return-as-a-link offer
   both _gone_ rather than disabled - there is nothing further to return.

5. **Window A: see it arrive.** Go to **Responses**, headed "Responses on the server - Completed
   QuestionnaireResponses held by Aidbox demo". The new row reads `adult-sepsis-screening` over
   `QuestionnaireResponse/<id> · Patient/pt-demo · stored <timestamp>`, with a blue **Patient**
   badge next to a `completed` badge. Press **View**: the detail says "Patient-asserted answers -
   Labelled `PATAST`", and shows the answers you gave.

   Go to **Sent requests**. The request carries a green **completed** badge. Nothing was scanned
   back, and window A never touched window B.

### Verifying scenario 1 on the server

The browser saying "accepted" is the app's account of itself. Check it with the operator
credentials, which the app does not have. Take the `urn:uuid:…` from step 2 and put it in the
environment so that `op run` passes it through:

```bash
REQ='urn:uuid:56d8331f-6646-4c90-b9fb-1e0d74b53af1' op run --env-file .env -- sh -c '
  curl -s -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
    "$AIDBOX_BASE_URL/fhir/QuestionnaireResponse?identifier=urn:ietf:rfc:3986%7C$REQ" \
  | jq "{total, response: (.entry[0].resource
         | {id, status, subject, security: .meta.security})}"'
```

`%7C` is not fussiness: the `|` between a search token's system and value has to be
percent-encoded, and `curl` given a raw `|` answers with an empty body and exit status 0 - which
looks exactly like a search that matched nothing.

Expect one response, completed, labelled `PATAST`, subject `Patient/pt-demo`:

```json
{
  "total": 1,
  "response": {
    "id": "64d6d1e7-bd4f-40df-854d-04fe4bfcb3d5",
    "status": "completed",
    "subject": { "display": "Jane Citizen", "reference": "Patient/pt-demo" },
    "security": [
      {
        "code": "PATAST",
        "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
        "display": "patient asserted"
      }
    ]
  }
}
```

Add `item` to that `jq` projection to see the answers themselves, nested under their groups:

```json
"item": [
  { "linkId": "patient-info", "text": "Patient Information",
    "item": [{ "linkId": "patient-age", "text": "Age",
               "answer": [{ "valueInteger": 52 }] }] },
  { "linkId": "pi-group", "text": "In the context of presumed infection, are any of the following true?",
    "item": [{ "linkId": "pi-lookssick", "text": "Looks sick",
               "answer": [{ "valueBoolean": true }] }] }
]
```

Then the provenance, using the response id from above:

```bash
ID='64d6d1e7-bd4f-40df-854d-04fe4bfcb3d5' op run --env-file .env -- sh -c '
  curl -s -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
    "$AIDBOX_BASE_URL/fhir/Provenance?target=QuestionnaireResponse/$ID" \
  | jq "{total, agents: [.entry[].resource.agent[0].who]}"'
```

Expect `total: 1` and one agent naming `Patient/pt-demo`: the answers are attributed to the
patient, not to the clinician who asked and not to whatever the filler's own device thought it
was. (If you have already done scenario 3, expect `total: 2` - see the known limitations.)

Then the Task:

```bash
REQ='urn:uuid:56d8331f-6646-4c90-b9fb-1e0d74b53af1' op run --env-file .env -- sh -c '
  curl -s -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
    "$AIDBOX_BASE_URL/fhir/Task?identifier=urn:ietf:rfc:3986%7C$REQ" \
  | jq "{total, task: (.entry[0].resource
         | {id, status, for: .for, requester, output, identifier})}"'
```

Expect:

```json
{
  "total": 1,
  "task": {
    "id": "01a02703-2244-7b7a-8f97-d87e9a931dd9",
    "status": "completed",
    "for": { "display": "Jane Citizen", "reference": "Patient/pt-demo" },
    "requester": { "display": "Dr Alex Fielding" },
    "output": [
      {
        "type": { "text": "questionnaire-response" },
        "valueReference": {
          "reference": "QuestionnaireResponse/64d6d1e7-bd4f-40df-854d-04fe4bfcb3d5"
        }
      }
    ],
    "identifier": [
      {
        "value": "urn:uuid:56d8331f-6646-4c90-b9fb-1e0d74b53af1",
        "system": "urn:ietf:rfc:3986"
      }
    ]
  }
}
```

The `output` names the response you just read, and the requester's own `identifier`, `for` and
`requester` are still on the Task: completing it changed two members and erased nothing.

## Scenario 2 - EHR launch with patient context

An EHR launch differs from a standalone one in exactly one way: it carries an opaque `launch` token
naming the patient on screen. Aidbox will mint one for you, which is this walkthrough standing in
for an EHR.

```bash
op run --env-file .env -- sh -c '
  curl -s -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
    -H "content-type: application/json" \
    "$AIDBOX_BASE_URL/rpc" \
    -d "{\"method\": \"aidbox.smart/get-launch-uri\",
         \"params\": {\"user\": \"$AIDBOX_E2E_USER_ID\",
                      \"iss\": \"$AIDBOX_BASE_URL/fhir\",
                      \"client\": \"smart-forms-health-links\",
                      \"ctx\": {\"patient\": \"pt-demo\"}}}" \
  | jq -r .result.uri'
```

Open the URI it prints. Sign in and consent as before.

Expect: the app lands signed in, and on the mint screen "Who is this for?" now reads "Pre-filled
from the patient you launched with", with `Patient/pt-demo` and `Jane Citizen` already in the
fields. Change either of them and the change sticks: the launch context is a default, not a
decision, because a request is not always for the patient on screen.

From there, continue as scenario 1 from step 2.

## Scenario 3 - sending twice

Two windows have to be open at once for this one. Before sending in scenario 1, open the same link
in a second private window and answer the form there too. Send from the first window, then send
from the second.

Expect: "Accepted by sczsqtqcgi.aidbox.app" in both windows, and re-running the
`QuestionnaireResponse` search above still reports `total: 1`, with the same `id`. The response
entry in the transaction carries a conditional-create key on the request identifier, so the second
send resolves to the response already stored rather than adding another. See the first known
limitation below for what the second send _does_ duplicate.

The second window has to be opened _before_ the first send because a link opened afterwards no
longer offers one - which is the next scenario.

## Scenario 3a - reopening a link whose answers are already in

Open the link from scenario 1 again, in a third private window.

Expect: "Accepted by sczsqtqcgi.aidbox.app", with no form, no "Send answers to..." button and
no pre-send disclosure. The page asks the destination what the published `Task` says as it opens;
finding the answers already recorded against it, it shows the state a completed send leaves rather
than a second empty form. Nothing is written - the browser's network panel shows the `GET` of
`Task/...` and no `POST`.

A `Task` the clinic completed or cancelled itself reads differently: without a
`questionnaire-response` output there is no evidence any answers were sent, so the form and the
send are offered as normal.

## Scenario 4 - the window closes

The grant a manifest hands out is short-lived on purpose. To watch it expire, register a short
lifetime and re-run setup:

```bash
op run --env-file .env -- env GRANT_TTL_SECONDS=60 npm run setup:aidbox
```

The `env` in the middle is load-bearing. `.env` sets `GRANT_TTL_SECONDS=3600` itself, and
`op run --env-file` applies the file over the environment it was invoked with, so the obvious
`GRANT_TTL_SECONDS=60 op run …` is silently overwritten back to 3600. Putting `env` inside the
`op run` sets the variable after the file has been applied. Check it took, if you like:

```bash
op run --env-file .env -- env GRANT_TTL_SECONDS=60 sh -c 'echo $GRANT_TTL_SECONDS'
```

The value reaches Aidbox as the two clients' `access_token_expiration`, so it is the token
endpoint that starts issuing one-minute tokens. The app clamps whatever it is given to the
`grantTtlSeconds` in `config/issuers.json` and states the smaller of the two, so nothing needs
restarting for a shorter lifetime to take effect - only for a longer one.

Mint a link, open it in the private window, and wait out the minute before pressing send.

Expect: no send offered. Instead a warning headed "The direct send has closed", saying the answers
can still be returned as a link for the requester to scan, and the **Return answers as a link**
button below it, which produces a link and a QR code holding the answers. Nothing has reached
Aidbox.

Then close the loop the other way. In window A, go to **Scan**, read or paste the returned link,
review what it holds, and accept it. The write goes through the session - the clinician's own
authority - and nothing was written until they accepted it.

Put the lifetime back afterwards:

```bash
op run --env-file .env -- npm run setup:aidbox
```

## Scenario 5 - a refusal never claims delivery

Break the credential and watch the app decline to lie about it. The least invasive way is to
deregister the Backend Services client, so the manifest can no longer mint a grant:

```bash
op run --env-file .env -- sh -c '
  curl -s -X DELETE -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
    "$AIDBOX_BASE_URL/Client/smart-forms-health-links-backend" -o /dev/null -w "%{http_code}\n"'
```

Mint a link and open it.

Expect: the form still renders - the invitation is readable without any token - but no direct-send
panel appears, because there is no grant to disclose. The return-as-a-link path is the only one
offered, and no state anywhere reads as delivered. If a grant was already in hand and the _send_
is what fails, the wording is "These answers were not accepted", the answers stay on the device,
and the scan-back path is offered instead.

Restore the client with `op run --env-file .env -- npm run setup:aidbox`. The re-run puts the same
client back rather than a new one: it reads `BACKEND_PRIVATE_JWK` from the environment when it is
set, so the key the app already holds keeps working. Verify with a `GET` on the same path, which
should answer `200`:

```bash
op run --env-file .env -- sh -c '
  curl -s -o /dev/null -w "%{http_code}\n" -u "$AIDBOX_CLIENT_ID:$AIDBOX_CLIENT_SECRET" \
    "$AIDBOX_BASE_URL/Client/smart-forms-health-links-backend"'
```

## Scenario 6 - an unregistered issuer

```bash
curl -s -i "http://localhost:3000/launch?iss=https://example.org/fhir"
```

Expect `HTTP/1.1 403 Forbidden`, no `Location` header, no `Set-Cookie`, and a page headed "This
launch was refused" that names `https://example.org/fhir` in the body. No session row is created;
the app never contacts a server it does not know. Afterwards `http://localhost:3000/` still offers
the registered server, so a refusal is not a dead end.

## Running the automated suite

The Playwright suite covers scenarios 1, 2, 3 and 6 against the same instance, driving two browser
contexts and asserting the server-side end state with the operator credentials.

```bash
op run --env-file .env -- npm run test:e2e
```

That is the whole command. It builds the SPA first, and Playwright starts `server/index.ts` for the
run - or reuses an app already listening on `APP_ORIGIN`, which is the usual case when
`overmind start` is up. **Reuse takes the server process as it finds it**: if you have changed
anything under `server/`, restart it before trusting a pass.

One environment trap. `reuseExistingServer` is `!process.env.CI`
(`e2e/playwright.config.ts:82`), so a shell with `CI` set - a CI job, or an agent session that
exports it - will not reuse an app already on the port and will fail trying to bind it. Unset it
for the run:

```bash
env -u CI op run --env-file .env -- npm run test:e2e
```

Four tests, run one at a time because they share one Aidbox instance:

| Spec                           | Scenario | What it asserts                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/fullLoop.spec.ts`         | 1 and 3  | mint, open with no cookie, fill, send, then one `PATAST` response for the request identifier with the typed answers in it, one `Provenance` attributing it to `Patient/pt-demo`, the `Task` completed with the response as its output - then a second send, after which the response count is still one |
| `e2e/ehrLaunch.spec.ts`        | 2        | a launch carrying `pt-demo` pre-fills the subject as `Patient/pt-demo` / Jane Citizen, and both fields still take an edit                                                                                                                                                                               |
| `e2e/refusal.spec.ts` (first)  | 6        | `403`, no `Location`, no `Set-Cookie`, the issuer named in the body, and the `sessions` table unchanged                                                                                                                                                                                                 |
| `e2e/refusal.spec.ts` (second) | 6        | after the refusal a requester surface still offers the registered server, and the header carries one link and no clinician navigation                                                                                                                                                                   |

Each spec mints its own invitation and depends on no other spec's leftovers, so any one of them can
be run alone:

```bash
op run --env-file .env -- npx playwright test -c e2e/playwright.config.ts e2e/refusal.spec.ts
```

`e2e/globalSetup.ts` runs first and fails fast with something readable when the environment is
wrong: it names the missing variable, or says nothing answered `APP_ORIGIN`, or says the issuer
under test is not in the app's registry.

The suite reads `SQLITE_PATH` directly, because proving that a refused launch created no session
means counting rows in the `sessions` table rather than trusting the absence of a cookie. That
makes the suite a local-stack instrument; pointed at a deployment whose database it cannot see, the
refusal spec is the one that will complain.

## Validation record

> This record describes what was run on the instance that existed at the time,
> `kuzfdswqmz.edge.aidbox.app`, which is gone. The host is left as it was on purpose: the record
> is a statement about what actually happened, and renaming it would make it a false one. The
> setup steps above now target the current instance, and this suite has **not** been re-run
> against it.

**Date:** 22 August 2026. **Instance:** `https://kuzfdswqmz.edge.aidbox.app`. **Commit:** branch
`001-confidential-smart-app` at the completion of T053.

| Scenario                            | How it was verified                                                                | Result                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 - the full loop                   | `e2e/fullLoop.spec.ts`, re-run for this record                                     | Pass, 24.6s. One `PATAST` response carrying the typed answers, one `Provenance` naming `Patient/pt-demo`, the `Task` completed with the response as its `output`                 |
| 2 - EHR launch with patient context | `e2e/ehrLaunch.spec.ts`, re-run for this record                                    | Pass, 8.9s. The launch patient pre-fills the subject as `Patient/pt-demo` / Jane Citizen, and both fields still take an edit                                                     |
| 3 - sending twice                   | `e2e/fullLoop.spec.ts` (its second half), re-run for this record                   | Pass. Two sends from two windows opened before either went; the response count is still one, with the same `id`                                                                  |
| 3a - reopening a sent link          | `e2e/fullLoop.spec.ts` (its last section), and by hand in Chromium                 | Pass. The reopened link shows "Accepted by kuzfdswqmz.edge.aidbox.app", no form and no buttons; its only request to the destination is the `Task` read, and there is no `POST`   |
| 4 - the window closes               | By hand, during the feature's acceptance work. Not re-run for this record          | An expired grant offered no send at all and issued zero requests to the destination; the scan-back return worked, and the write went through the clinician's session             |
| 5 - a refusal never claims delivery | By hand, during the feature's acceptance work. Not re-run for this record          | An authorisation refusal never claimed delivery: no state anywhere read as delivered, and the answers stayed on the device                                                       |
| 6 - an unregistered issuer          | `e2e/refusal.spec.ts`, both tests, re-run for this record; and by hand with `curl` | Pass, 315ms and 421ms. By hand: `403`, no `Location`, no `Set-Cookie`, `https://example.org/fhir` named in the body, and `/api/issuers` still offering the one registered server |

### What was run for this record, and what was not

Scenarios 1, 2, 3, 3a and 6 were re-run here, in one command, against a freshly built SPA and a
server started from this branch:

```bash
env -u CI op run --env-file .env -- npm run test:e2e
```

```
Running 4 tests using 1 worker

  ✓  1 [chromium] › e2e/ehrLaunch.spec.ts:28:1 › an EHR launch pre-fills the launch patient as the subject, and it stays editable (9.4s)
  ✓  2 [chromium] › e2e/fullLoop.spec.ts:66:1 › the full loop lands one labelled response, one provenance and a completed task (26.4s)
  ✓  3 [chromium] › e2e/refusal.spec.ts:58:1 › an unregistered issuer is refused by name, with no redirect and no session (317ms)
  ✓  4 [chromium] › e2e/refusal.spec.ts:91:1 › after a refusal the app still offers a registered server to launch from (427ms)

  4 passed (38.9s)
```

Scenarios 4 and 5 were **not** re-run for this record, and this section should not be read as
claiming otherwise. Both were exercised by hand against this instance during the feature's
acceptance work, and the behaviour in the table above is what was observed then. Neither is
automated, for the same reason in both cases: one needs a real wait against a re-registered token
lifetime, and the other needs the Backend Services client deregistered and restored, which
disturbs the instance every other scenario shares.

What does hold for them here, offline and repeatably, is the logic underneath: 45 tests across
`tests/src/grantExpiry.test.ts`, `tests/src/sendFailures.test.ts` and
`tests/src/scanBackFallback.test.tsx` assert that an expired grant issues no request at all rather
than a failing one, that a refused send says the answers were not accepted, and that the scan-back
return is promoted to the primary action in both cases. Those are properties, not a demonstration;
the walkthrough above is the demonstration, and it is why scenarios 4 and 5 are written out step by
step rather than left to the suite.

### The offline gates, same date

| Gate                       | Result                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run typecheck`        | Clean                                                                                      |
| `npm run lint`             | 0 errors, 211 warnings (all `jsdoc/*`)                                                     |
| `npm run lint:duplication` | 139 duplicated lines of 19,600, 0.71%                                                      |
| `npm run format:check`     | All matched files use Prettier code style                                                  |
| `npm test`                 | 486 tests in 24 files, all passing                                                         |
| `npm run test:coverage`    | Lines 88.33%, statements 88.4%, branches 83.23%, functions 90.3%, against an 80% threshold |
| `npm run build`            | Clean                                                                                      |
| `npm run build:server`     | Clean                                                                                      |
| `npm run check:e2e`        | 10 checks, all passing, against the public forms catalogue                                 |
| `npm run check:e2e-shl`    | 36 checks, all passing                                                                     |

`npm run check:roundtrip` was **not** run, and cannot be run from this checkout. It imports three
`QuestionnaireResponse` fixtures from a sibling `smart-forms` monorepo
(`../../smart-forms/packages/sdc-template-extract/…`), and esbuild fails to resolve them before any
assertion executes. That dependency predates this feature and is unchanged by it, so its absence is
not a regression - but it does mean the assertions in `scripts/roundtrip.ts` are unverified in any
checkout without that sibling directory, including CI.

### The instance answers a conditional `GET` with a 500

Aidbox returns `ETag: "59487"` and `Cache-Control: no-cache` on a `Task` read, then answers the
revalidation that pair invites with an HTTP 500 and an `OperationOutcome`. Every form of the header
fails identically - `If-None-Match: 59487`, `"59487"` and `W/"59487"` - so it is the conditional
read itself, not the ETag's syntax.

It matters because the filler reads the published `Task` twice in one page: once when the link is
opened, to see whether the answers are already there, and once immediately before a send, to build
the completion. Left cacheable, the second read is a revalidation, the destination answers 500,
the `Task` entry is dropped as unreadable, and the request silently never reads as completed -
observed live before the fix, with both reads returning 200 after it. Both reads therefore go out
with `cache: "no-store"` (`src/fill/directSend.ts`, `src/fhir/submit.ts`), which is where a
token-authorised read of clinical state belongs anyway.

## Known limitations

### A replayed send leaves a second Provenance

Sending the same answers twice leaves one `QuestionnaireResponse` and one completed `Task`, as
scenario 3 shows - and **two** `Provenance` resources.

The reason is in the wire contract. The response entry in the submission transaction carries
`ifNoneExist` keyed on the request identifier, so a second send resolves to the response already
stored. `contracts/shl-wire.md` gives the Provenance entry no conditional-create key, so its
second `POST` is an unconditional create and succeeds. The Task escapes the problem for a different
reason: a send reads the Task first and leaves alone anything already finished, so a replay simply
omits it.

This is left as it stands rather than fixed, because the transaction shape is an interop contract
with Platypus Health (FR-027, SC-008): an invitation this app mints has to validate against the
producer expectations on the other side without adaptation, and quietly adding a key to one entry
would change the shape both sides agreed on. SC-002 constrains the response count, which is what
holds. Fixing it properly means changing the contract on both sides - a `Provenance` conditional
create keyed on target plus recorded time, or a server-side rule - and that is separate work.

The practical consequence: provenance for a patient-asserted response is not guaranteed to be
one-to-one with the response. Anything counting provenance records should count distinct targets.

### A photographed link is a working credential until it expires

The link is a pointer and a decryption key, with no passcode. That is deliberate: a passcode is one
more thing to communicate to a patient, and the whole design goal is a filler who configures
nothing. But it means anyone who photographs the QR code, or sees the URL over a shoulder, holds
what the intended recipient holds. They can fetch the manifest, and each fetch mints a fresh
short-lived access token scoped to that one request.

What that token can do is deliberately small: create a `QuestionnaireResponse`, and read and update
the one request `Task`. It cannot read the patient's record, cannot read other responses, and
cannot touch anything else on the server. And it lives for `GRANT_TTL_SECONDS` - an hour by default,
and worth setting lower for a real deployment.

What it can do is submit answers that will be recorded as the patient's own. The mitigation is the
link's own lifetime (`linkLifetimeDays`, 30 by default) and the grant's; the accepted risk is the
window in between. Shortening either narrows it. Closing it entirely means a passcode, which is a
product decision, not an implementation gap.

## When something does not work

| Symptom                                                     | Cause to check first                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/api/issuers` answers `[]`                                 | `ISSUER_REGISTRY_PATH` points at a file that is not there                                                       |
| Sign-in ends at `access_denied`                             | The consent form was denied. Its **deny** button precedes its **allow** button                                  |
| The form list is empty after signing in                     | `setup:aidbox` has not run against this instance                                                                |
| The mint fails with "could not be recorded on the server"   | The session's own authority cannot write `Task`; check the launch client's `AccessPolicy`                       |
| No direct-send panel on an opened invitation                | The manifest minted no grant: the Backend Services client, its JWKS or the signing key                          |
| "These answers were not accepted"                           | The grant was refused at the point of the send; check `access_token_expiration` and the backend client's scopes |
| A manifest fetch fails in the browser but works with `curl` | CORS on the Aidbox instance; the setup run reports its mode                                                     |
