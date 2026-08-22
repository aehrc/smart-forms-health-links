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

| Thing                    | Where it comes from                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Aidbox instance      | `https://kuzfdswqmz.edge.aidbox.app`                                                                                                                                 |
| Operator API credentials | 1Password item **Smart Problems Admin Client for Aidbox** (`username`, `password`) in the **Work Agent** vault                                                       |
| App secrets              | 1Password item **Smart Forms Health Links** in the **Work Agent** vault: `session cookie secret`, `launch client secret`, `backend private jwk`, `e2e user password` |
| `.env`                   | Copy `.env.example`. It holds `op://` references, never values, and is gitignored                                                                                    |
| `config/issuers.json`    | Copy `config/issuers.example.json`. Secret-bearing fields hold `env:VARIABLE_NAME` references, resolved from the environment at load                                 |
| 1Password CLI            | `op` on the path, signed in (a service account token works)                                                                                                          |

The `launch client secret`, `backend private jwk` and `e2e user password` fields are _created by the
first setup run_, which prints them once. If the 1Password item does not have them yet, run the
setup step below first and paste what it prints into those fields.

`op run` resolves the references and passes the values to one process. Nothing is ever echoed:

```bash
op run --env-file .env -- <command>
```

Never use `op read` and never print a resolved value; the whole arrangement exists so that no secret
lands in a shell history, a log or a transcript.

## One-time setup

```bash
npm install
op run --env-file .env -- npm run setup:aidbox
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

Expect a one-element array naming `https://kuzfdswqmz.edge.aidbox.app/fhir`. An empty array means
`ISSUER_REGISTRY_PATH` is pointing at a file that is not there.

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
   disclosure headed "Answers go straight to kuzfdswqmz.edge.aidbox.app", and below that the
   request names who asked ("Dr Alex Fielding has asked for this form to be completed"), who it is
   for ("Addressed to Jane Citizen") and the request reference. The header carries the product name
   and nothing else - no navigation this window could use.

4. **Window B: fill and send.** Answer some questions. "Age" takes a number; the six vital signs
   are deliberately read-only, because they come from the patient record rather than from whoever
   is answering. The Yes/No items are all editable.

   Press **Send answers to kuzfdswqmz.edge.aidbox.app**. It does not send: it asks again, naming
   the host, because a send writes into a medical record and cannot be taken back. Press **Confirm
   and send**.

   Expect: "Accepted by kuzfdswqmz.edge.aidbox.app", and the form and the return-as-a-link offer
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

Reopen the link from scenario 1 in the private window, answer the form again, and send again.

Expect: "Accepted by kuzfdswqmz.edge.aidbox.app" a second time, and re-running the
`QuestionnaireResponse` search above still reports `total: 1`, with the same `id`. The response
entry in the transaction carries a conditional-create key on the request identifier, so the second
send resolves to the response already stored rather than adding another. See the first known
limitation below for what the second send _does_ duplicate.

## Scenario 4 - the window closes

The grant a manifest hands out is short-lived on purpose. To watch it expire, register a short
lifetime and re-run setup:

```bash
GRANT_TTL_SECONDS=60 op run --env-file .env -- npm run setup:aidbox
```

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
