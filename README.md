# Smart Forms Health Links

Ask someone to fill in a FHIR questionnaire by handing them a scannable
[SMART Health Link](https://docs.smarthealthit.org/smart-health-links/), let them complete it on
another device with no account and no login, and have the answers land straight back in your own
clinical system.

The requester side is a **confidential SMART app**, launched from a SMART-enabled FHIR server by
either an EHR launch or a standalone launch against a server the operator has registered. That one
launched server is everything: the questionnaire catalogue, the patient list, the destination for
responses and the store for request tasks. The only other service it names is a terminology server.

Every secret lives in a server-side component. The confidential client's secret, the SMART Backend
Services signing key, launch tokens and minted access tokens exist only there; the browser holds an
opaque session cookie and nothing else.

Built on [`@aehrc/smart-forms-renderer`](https://www.npmjs.com/package/@aehrc/smart-forms-renderer)
from npm - the app has no build-time coupling to the
[smart-forms](https://github.com/aehrc/smart-forms) monorepo. (One dev-only check script imports test
fixtures from a sibling checkout; see [Checks](#checks).)

```bash
npm install
cp .env.example .env                        # then read it; every secret is an op:// reference
op run --env-file .env -- overmind start    # http://localhost:3000
```

**This is a demonstrator, not a product** - see [Known limitations](#known-limitations) before
showing it to anybody, because a minted token is not bound to the invitation it travelled in.

## Contents

- [What this demonstrates](#what-this-demonstrates)
- [Quick start](#quick-start) - install, configure, then walk the round trip end to end
- [What it does](#what-it-does) - the browser routes and the server routes
- [The round trip](#the-round-trip) - nine steps, with measured sizes
- [Two ways to return answers](#two-ways-to-return-answers) - and why the direct send is primary
- [How links work](#how-links-work)
- [One server, one authority](#one-server-one-authority)
- [Configuration](#configuration)
- [Deploying](#deploying)
- [Repo layout](#repo-layout)
- [Known limitations](#known-limitations)
- [Checks](#checks)
- [Notes](#notes) - the gotchas worth knowing before changing anything
- [Provenance](#provenance)
- [Licence](#licence)

## What this demonstrates

The repo exists to make six claims concrete, each of which is either non-obvious or contradicted by
how SHL is usually described:

1. **A whole FHIR Questionnaire fits in a QR code** - by reference, not by value. The GP Chronic
   Condition Management Plan in `fixtures/` is 111,071 bytes of JSON; the link that carries it is
   about **250 bytes**, because the form is encrypted, hosted and named by a URL plus a key.
2. **The filler needs no account, no login and no configuration.** Everything required to render the
   form, and everything required to send the answers, travels inside the encrypted manifest.
3. **Answers can come back without waiting to be scanned, and without going off-spec.** SHL defines
   no upload channel, so nothing is uploaded _to_ the link. A manifest fetch returns a second
   encrypted file - `application/smart-api-access` - carrying a short-lived access token, and the
   filler writes the answers into the clinic's own server with it. That is ordinary FHIR REST
   authorised by an ordinary OAuth token; the novelty is only in how the token got there.
4. **The send window starts when the patient opens the link, not when the clinic minted it.** The
   token is minted fresh on every manifest fetch through a SMART Backend Services client, so a link
   can live for thirty days while the credential inside it lives for an hour.
5. **Reading a link somebody else wrote is the hard part**, and it is where a strict implementation
   quietly loses data - bare resources instead of Bundles, multi-file manifests, passcode prompts,
   unresolvable questionnaire canonicals. Each of those is legal SHL and each is handled. See
   [Reading a link this app did not write](#reading-a-link-this-app-did-not-write).
6. **No third-party infrastructure is required.** The component that mints is the component that
   hosts: the same server process that publishes the request task also serves the manifest. There is
   no blob host, no relay, no manifest service to stand up and nobody else holding the ciphertext.

It also serves as a worked example of interoperating with
[Platypus](https://github.com/aehrc/platypus): the manifest shape, the grant file and the submission
transaction are the contract that app's direct-send feature implements, and its detection contract
and reply crypto are both reimplemented here and checked against transcriptions of its own code.

## Quick start

### Prerequisites

|                                                    |                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Node                                               | **22 or newer** (Vite 6, the server bundle and the check scripts all target `node22`)              |
| npm                                                | ships with Node                                                                                    |
| [`overmind`](https://github.com/DarthSim/overmind) | runs the `Procfile` - the SPA and the server are two processes in dev                              |
| [`op`](https://developer.1password.com/docs/cli/)  | resolves the `op://` references in `.env`; no secret is ever written to disk                       |
| A registered FHIR server                           | **required.** There is no anonymous mode any more; see [the issuer registry](#the-issuer-registry) |
| A browser                                          | any current one; the scanner needs camera access and a secure context                              |
| A sibling `../smart-forms` checkout                | only for `npm run check:roundtrip`, which imports fixtures from it. Not needed to run the app      |

### Configure

Three things have to exist before the app will start.

```bash
cp .env.example .env                       # process configuration and secret references
cp config/issuers.example.json config/issuers.json
```

`.env.example` is the authoritative list of environment variables and says what each one is for.
`config/issuers.example.json` is the authoritative shape of the issuer registry. Neither example
holds a secret value: the registry's secret-bearing fields hold `env:VARIABLE_NAME` references, and
`.env` holds `op://` references that `op run` resolves into the process environment.

Then register the app with the server, which for the demonstration instance is one idempotent
command:

```bash
op run --env-file .env -- npm run setup:aidbox
```

That writes both client registrations - the confidential launch client and the Backend Services
client - along with their access policies and some demonstration data. It is safe to re-run: the
second application changes nothing. The full walkthrough against the validation instance, including
what to check on the server afterwards, is in
[`docs/aidbox-validation.md`](docs/aidbox-validation.md).

### Run it

```bash
op run --env-file .env -- overmind start
```

Open <http://localhost:3000>. The `Procfile` starts two processes and they share that one origin:
`web` is `npm run build -- --watch`, rebuilding `dist/` on save, and `server` is the Fastify BFF
under `tsx watch`, serving `dist/` alongside the API.

So you get rebuild-on-save rather than hot module replacement, and that is a deliberate trade rather
than an oversight. The session is a cookie, `/launch` builds its `redirect_uri` from `APP_ORIGIN`, and
the authorisation server is registered against that exact callback - so the browser comes back to the
BFF's origin and the cookie is set there. A Vite dev server proxying the API would load the SPA on a
second origin and then sign you in on the first one. One origin is the whole point of the BFF, and it
costs HMR.

You should land on a page asking you to connect. Pick a registered server, complete its
authorisation, and you are signed in: the questionnaire list is the questionnaires that server holds.
An empty list means that server holds no `Questionnaire` resources, not that anything is broken.

### Walk the round trip

The whole point of the app is a loop between two devices, so it is worth walking it once. Do the
one-machine variant first, then the two-device one if you want to demo the QR codes.

#### One machine, two windows

1. **Sign in.** Open the app origin, choose your server, complete the authorisation. If you arrived
   by EHR launch instead, you are already signed in and any patient the launch named is remembered.
2. **Pick a form.** On `/`, search the launched server's questionnaires and click **Request** on a
   result. (`Fill` is the shortcut that skips the request leg and just fills the form yourself.)
3. **Say who it is for.** Optional, but worth doing: search the launched server for the patient and
   click them. An EHR launch that supplied a patient pre-fills this. The subject is what the grant
   will name, so a request that names nobody produces answers filed against nobody.
4. **Create request link.** The server publishes the request `Task` with your session's authority,
   encrypts the invitation payload under a fresh link key, stores it, and hands back a QR code and a
   copyable `shlink:/…` URL. The request now appears under **Sent requests**, because that list is
   the published tasks.
5. **Copy the link** and open it in a second browser window - ideally a private window, to make the
   point that no shared state and no session are involved.
6. **Fill it in.** The second window fetches the manifest, decrypts both files and renders the form.
   The header names who asked, who it is addressed to, and - this is the new part - that the answers
   will be sent directly to the destination, naming the host.
7. **Send answers to `<host>`.** One confirmation, one transaction. The response is conditionally
   created on the request identifier and labelled patient-asserted, a `Provenance` names the patient
   as author, and the request task is completed with the response as its output.
8. **Confirm it landed.** Back in the first window, `/responses` lists the stored response and the
   row on **Sent requests** flips to completed. Nothing was scanned back and nothing was relayed.
9. **Send again, from the still-open filler window.** The terminal state refuses: there is nothing
   further to send. Replay the transaction by hand and the server still holds exactly one response,
   because the conditional create is keyed on the request identifier.

#### Two devices, with the camera

Same steps, with the phone doing 6 and 7. Two things bite here:

- **The link points at `window.location.origin`**, which on the laptop is `http://localhost:3000` -
  a URL the phone cannot open, and an origin the manifest fetch would fail against. Set `linkBaseUrl`
  in `public/config.json` to something the phone can reach (your LAN IP, or a tunnel) before minting.
  `APP_ORIGIN` in `.env` has to agree with it, because the authorisation redirect goes there.
- **The camera needs a secure context.** `localhost` qualifies; the same server opened by LAN IP does
  not, so the phone will refuse to scan even though it can load the page. Use HTTPS or a tunnel
  (`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`) and point both `linkBaseUrl`
  and `APP_ORIGIN` at the tunnel URL. `/scan` has a paste box as the fallback on both sides.

## What it does

### The browser routes

| Route          | Session? | Purpose                                                                         |
| -------------- | -------- | ------------------------------------------------------------------------------- |
| `/`            | yes      | Search and list Questionnaires on the launched server                           |
| `/request/:id` | yes      | Mint an invitation: publish the request `Task`, get back a link and a QR        |
| `/requests`    | yes      | Sent requests, and their status, read from the published tasks                  |
| `/responses`   | yes      | QuestionnaireResponses already stored on the launched server, read-only         |
| `/patients`    | yes      | Patients on the launched server - pick a request's subject, or filter responses |
| `/fill/:id`    | yes      | Fill a form directly, without the request leg                                   |
| `/view#<link>` | no       | Open any link - **dispatches on payload**: fill a request, or review a response |
| `/scan`        | no       | Read a QR with the camera, or paste a link - the fallback return path           |

A session-gated route with no session renders a connect prompt rather than an error or an empty page,
and says which of the two reasons it is: never launched, or the session has expired.

`/view` deliberately decides what to show from the payload rather than the route, because a scanner
cannot know whether it just scanned a request or a completed response. A link fragment arriving at
the site root is forwarded to `/view` too, since `https://viewer.example.org#shlink:/…` is the
conventional shape, and that forward happens ahead of the session gate: somebody arriving with a link
is a filler and must never be asked to sign in.

### The server routes

One Fastify process serves all of this from one origin.

| Route                        | Session? | Purpose                                                                                          |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `GET /launch`                | no       | EHR launch (`iss` + `launch`) or standalone (`iss` alone). Refuses an unregistered `iss` by name |
| `GET /auth/callback`         | no       | Validates `state`, exchanges the code, sets the session cookie                                   |
| `GET /api/session`           | yes      | Who is signed in, against which issuer, and until when                                           |
| `POST /api/logout`           | yes      | Deletes the session row and clears the cookie                                                    |
| `GET /api/issuers`           | no       | Registered servers for the standalone picker. Labels and issuer URLs only                        |
| `ALL /api/fhir/*`            | yes      | Proxy to the session's FHIR base, with the access token attached server-side                     |
| `POST /api/invitations`      | yes      | Mint an invitation: publish the task, encrypt and store the payload                              |
| `POST /shl/:id`              | no       | The SHL manifest. Mints a fresh grant per fetch                                                  |
| `GET /.well-known/jwks.json` | no       | The Backend Services client's public JWKS, registered as its `jwks_uri`                          |
| `GET /health`                | no       | Liveness and readiness. Says nothing about configuration                                         |
| `GET /*`                     | no       | The built SPA, with a rewrite to `index.html` for client-side routes                             |

The proxy is the whole reason the browser needs no credential. The SPA issues
`GET /api/fhir/Questionnaire?…` and the server appends the path to the session's FHIR base, attaches
`Authorization: Bearer …` and passes the response back verbatim. Every requester read and write goes
through it, including the write performed when somebody accepts a scanned response.

`/api` paths that match no route answer as JSON, never as the SPA shell. A fetch client that gets an
HTML page where it expected an API error fails somewhere much less informative than the request.

## The round trip

```
MINT      requester's session authority, hosted by the requester's own server
  1. pick a Questionnaire, mint Task{status:requested, focus:Q, for:Patient}
  2. POST the Task to the launched server        -> .../Task/{id}
  3. Bundle{Questionnaire, Task+taskUrl} -> JWE (alg:dir, enc:A256GCM), stored
  4. shlink:/{url, key, exp, label}   ~250 bytes, fits a QR, no flag

OPEN      any device, no account, no login, no configuration
  5. POST {url} {recipient}  -> manifest, two embedded files:
       application/fhir+json          the invitation, sealed at mint time
       application/smart-api-access   a token minted just now, expires_in 3600
  6. decrypt both -> render -> fill

SEND      the filler writes to the clinic's server itself
  7. POST {aud} Bearer <token>, one transaction:
       QuestionnaireResponse  ifNoneExist=identifier=<request>   PATAST
       Provenance             agent.who = the patient
       Task/{id}              status:completed, output -> response   (PUT, ifMatch)
  8. terminal state: accepted by <host>

FALLBACK  when the window has closed, or the send was refused
  9. the filler mints an inline sfhl:/ carrying the answers in the fragment;
     the requester scans or pastes it into /scan, reviews the answers
     read-only, and accepts under their own session
```

Measured for the GP Chronic Condition Management Plan fixture, built through `buildInvitationBundle`
and sealed with the app's own `encryptJwe`:

|                                          | bytes   |
| ---------------------------------------- | ------- |
| Questionnaire                            | 111,071 |
| Invitation Bundle (Questionnaire + Task) | 111,960 |
| Encrypted invitation file                | 149,361 |
| **The link itself**                      | **246** |

The link is small for the same reason it was before: it names the payload rather than carrying it.
What changed is who holds the payload. `check:roundtrip` asserts a minted `shlink:` stays under 400
bytes, which is the property that matters - past roughly 2 KB a QR code stops being scannable from
across a desk.

## Two ways to return answers

**SMART Health Links are strictly one-directional.** Neither the
[SHL spec](https://docs.smarthealthit.org/smart-health-links/spec/) nor the
[HL7 links-specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html)
defines any submission, upload or writeback channel, and neither mentions questionnaires or requests
for data at all. Nothing here changes that: nothing is ever uploaded to a link.

What the link carries instead is a **credential**, and the filler uses it to perform an entirely
ordinary FHIR write against the clinic's own server. The return leg is therefore not an SHL feature
at all - it is SMART Backend Services and a FHIR transaction, delivered through an SHL manifest
because that is already an encrypted channel from the requester to whoever holds the link.

|                           | Direct send                                       | Scan-back                                     |
| ------------------------- | ------------------------------------------------- | --------------------------------------------- |
| Who it suits              | anyone holding the link, on any device            | a filler whose send window has closed         |
| Needs from the filler     | nothing                                           | nothing; the answers travel inside the link   |
| Needs from the requester  | nothing beyond the registration                   | somebody able to scan or paste                |
| Reviewed before it lands? | no - the patient's own answers, labelled as such  | yes                                           |
| Who performs the write    | the filler, with a scoped short-lived token       | the requester, with their session authority   |
| Answers protected?        | encrypted in the manifest, TLS to the destination | **no** - deflated into the URL, not encrypted |
| Default                   | **primary**                                       | fallback                                      |

**The direct send is primary**, and it is the channel [Platypus](https://github.com/aehrc/platypus)
implements. The scan-back path is the one that used to be primary, and it stays because it is the
only path that works when the credential has expired or been refused. Both leave the answers on the
filler's device until something has actually accepted them. The fallback is the weaker of the two on
confidentiality - see
[the fallback link is not encrypted](#the-fallback-link-is-not-encrypted).

### The grant, and why it is minted per fetch

The second manifest file is `application/smart-api-access`, and its plaintext is small:

```json
{
  "access_token": "<opaque>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "aud": "https://kuzfdswqmz.edge.aidbox.app/fhir",
  "patient": "pt-1"
}
```

`patient` is present exactly when the request named a destination patient. `aud` is the launched
server's FHIR base and is the only origin the token is ever presented to.

**The token is minted when the manifest is fetched, not when the link was minted.** That single
decision is what makes the arithmetic work. A link has to live long enough to be posted, printed or
forwarded - the default is thirty days - and a token that lived that long would be a thirty-day
write credential sitting in a QR code. Minting per fetch decouples the two: the link lives for a
month, the credential lives for an hour, and the hour starts when the patient opens the form rather
than when the clinic sent it. Two fetches produce two different tokens, which is a property the
tests assert rather than an accident.

The cost is that the server has to keep the link key, because the grant has to be encrypted under it
long after minting. So the host can decrypt its own invitations. That is a real departure from the
usual SHL posture of a blind host, and it was accepted deliberately: the alternative was multi-day
tokens.

**A mint failure degrades rather than fails.** If the authorisation server is down or has
deregistered the Backend Services client, the manifest still serves the invitation file on its own.
The form still opens, the filler falls back to the scan-back return, and the failure is counted
server-side for the operator rather than shown to the patient - who can do nothing about it.

### What the write looks like

One transaction, and every rule about its shape is decided in one function
(`buildSubmissionTransaction` in `src/fill/directSend.ts`) so that a rule can be read off rather than
reconstructed from a request pipeline:

- The **response** is a conditional create - `ifNoneExist=identifier=…` on the request's durable
  identifier - carrying the `PATAST` patient-asserted security label and no filler-local
  identifiers. Sending twice therefore leaves one response.
- The **provenance** names the patient as author and targets the response by its `fullUrl`.
- The **task** is completed with the response as its output, and only under three conditions: its
  published address is on the grant's own origin, a pre-send read found it still actionable, and
  that read returned a version to `ifMatch` against. Anything else means no task entry and the
  answers go anyway. Losing the status flip costs the requester a tidy list; losing the answers costs
  a patient the time they spent typing them.

The credential goes to exactly one origin. Both requests use `redirect: "manual"`, because a
destination that answers with a redirect has told the browser to present the request somewhere else,
and following that would hand a write credential for a clinical record to whoever controls the
target - while reporting the answers as delivered. A published task URL that is not on the grant's
origin is not fetched at all, not even to see whether it would have worked.

The exact wire shapes are fixed by the interoperability contract, not by this implementation, because
a Platypus build has to produce and consume the same thing.

### Reading a link this app did not write

A link from a third-party filler is a SMART Health Link this app did not write, and the answers in it
are worth having. Decoding is therefore deliberately tolerant in four ways. Each of these describes a
link that is entirely legal and that a stricter reader rejects or silently truncates:

- **A bare resource, not just a Bundle.** An SHL manifest file is `application/fhir+json` - any FHIR
  resource. A filler that parks a bare `QuestionnaireResponse` has done nothing wrong, so it is
  normalised into a Bundle rather than refused.
- **Every FHIR file in a manifest, merged.** A payload split across files - the answers in one, the
  `Provenance` attributing them in another - is one payload, not a choice between them. Taking only
  the first would drop the `PATAST` attribution that makes a reply safe to store. Content types are
  matched after stripping any `;charset=…`.
- **A passcode prompt, not a dead end.** A `P`-flagged link asks before it knocks: the prompt appears
  without a network round trip, because a manifest server may count a passcode-less request as a
  failed attempt and lock the link permanently. `remainingAttempts` is surfaced when the server sends
  it.
- **A raw-answers table when the form cannot be resolved.** A response cites whatever canonical the
  app that wrote it used, and that is frequently a form the launched server does not hold. That is
  the _expected_ case, not an exceptional one. The answers are the clinical content and the
  definition is presentation, so the review still works and saving is still enabled.

A file that will not decrypt costs its own content, not the whole link. Anything skipped is reported
on screen rather than to the console - the only person who can judge whether a dropped file mattered
is the one reading the answers.

### What went, and what is merely tolerated

Two return channels this app used to offer are **no longer minted**:

- **The anonymous server write.** An invitation declared `sdc-questionnaire-endpoint` on the form and
  a filler holding nothing but the link could `POST` a response into the named server. The grant
  replaces it and is strictly better: a token that expires and is scoped to four operations, rather
  than an endpoint that has to accept anonymous writes from anyone.
- **The encrypted reply slot.** A slot was minted alongside the request and the answers came back
  encrypted to a public key whose private half never left one browser. Its requester half is gone -
  no slot to create, no key to hold, no polling, and nothing to export between browsers.

Both are **still honoured on inbound links**. A request from another producer that declares a reply
descriptor is still answerable here, because refusing to honour someone else's return channel would
strand their answers rather than protect anyone. The design record for both channels, and which of
them this app now mints, is in
[`docs/shl-form-reply-channel.md`](docs/shl-form-reply-channel.md); what counts as an inbound
response link, and the token channel's own wire summary, is in
[`docs/response-links.md`](docs/response-links.md). Both are written so a third party can implement
against them without reading this source.

### And why the write itself is not novel

`POST /QuestionnaireResponse` is core FHIR REST and exactly SDC's Form Receiver model. SDC even
specifies the destination, via
`http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint` - which this app honours on the
scan-back accept path (including its "send to all listed endpoints" rule) and which smart-forms
lists as unsupported.

**Correlation runs from the Task outward**, because R4 gives QuestionnaireResponse no way to point at
a Task: `basedOn` accepts only `CarePlan|ServiceRequest`, `partOf` only `Observation|Procedure`, and
`identifier` is `0..1`. So `Task.focus` names the Questionnaire, `Task.output.valueReference` names
the response, and the Task round-trips inside the Bundle. Its `identifier` is the durable key - the
`urn:uuid` references do not survive the trip, but that does, and it is also the conditional-create
key that makes a replayed send idempotent.

**`Task.focus` names the Questionnaire by canonical, and this is load-bearing.** A `urn:uuid`
pointing at the Bundle entry is arguably better FHIR, and is what this shipped before - but it stops
meaning anything once the Bundle is taken apart, so a filler holding only the Task cannot say which
form it has. `focus.type` is `Questionnaire`, and the two **must change together**: readers exist
that short-circuit on `focus.type === 'Questionnaire'` and stop consulting `Task.input`, so a `type`
alongside a `urn:uuid` reference is worse than neither - it silently costs a third-party filler its
Task, its addressing and every return channel, while the form still opens. `check:roundtrip` asserts
that half-change is _not_ detectable, so anyone who reintroduces it finds out here rather than at a
connectathon.

**The invitation Task carries one extension the filler needs**, naming the published task's absolute
address on the launched server. Without it there is nothing to complete; with it pointing anywhere
other than the grant's origin, a correct filler skips the task leg rather than presenting a
credential off-origin.

## How links work

Two link shapes exist, and which one is used is no longer a setting. An invitation is always a
hosted SMART Health Link, minted by the server; a filler's return is always an inline link, minted
in the page. Reading tries every registered codec, so either opens.

### The invitation link

Minted links are ordinary manifest-mode SMART Health Links. The payload names a manifest URL on this
app's own origin and carries the key that decrypts what comes back:

```
shlink:/<base64url({"url":"https://links.example.org/shl/<id>","key":"<43 chars>","exp":…,"label":"…"})>
```

There is **no flag**. `U` would mean a single file fetched with a plain `GET`, which cannot carry a
grant minted per fetch and cannot carry two files; omitting it means a manifest fetched by `POST`.
That also matches the fixtures the Platypus contract is pinned against.

Two consequences worth stating, because the previous design had the opposite trade:

- **The links can be revoked and varied**, at least in principle - the host is ours, the id is a
  database row, and an expired invitation is refused. An unknown id and an expired id give the same
  404, so the route is not an oracle for which links have ever been minted.
- **A passcode is now structurally possible**, since `P` is only excluded by `U`. Nothing implements
  one yet; reading a passcode-protected manifest already works.

### Two transports, one interface

Both implement `LinkCodec` (`src/link/codec.ts`); `decodingCodec()` sniffs the prefix across every
registered codec, so links of either kind stay readable regardless of which end produced them.

|                     | `shlink:/` (`shlCodec.ts`) | `sfhl:/` (`bespokeCodec.ts`)      |
| ------------------- | -------------------------- | --------------------------------- |
| Payload             | encrypted, hosted          | deflated, inside the URL fragment |
| Encryption          | A256GCM                    | **none**                          |
| Hosting             | required                   | none                              |
| Size limit          | none                       | the QR's, ~14 KB raw JSON         |
| Third-party wallets | yes                        | no                                |
| Who mints it        | the BFF, for invitations   | the page, for a filler's return   |

The SHL codec reads both hosting modes - a `U`-flag single file and a manifest, including a
passcode-protected one - so a filler that publishes either way works. It mints only the manifest
form.

### Why the filler's return is an inline link

The bespoke codec deflates the whole response Bundle into the URL fragment and hosts nothing. It was
built as "the only return path open to an app with no server of its own", and that is exactly what an
anonymous filler is: no account, no storage, and nothing on this app's public surface it is allowed
to write to.

That last part is the constraint. The only routes reachable without a session are the manifest,
launch, the callback, the issuer list, the JWKS and static assets. Adding an anonymous
payload-hosting route would put an open write endpoint on a server that holds every secret, to
support a fallback. An inline link needs no endpoint at all, and works with no network.

The honest cost is that the answers are compressed, not protected: whoever photographs the QR or
reads the URL can recover them. The previous design encrypted this payload - and parked the
ciphertext on a shared public sandbox, which is the thing this feature removed. See
[the fallback link is not encrypted](#the-fallback-link-is-not-encrypted).

The other cost is a ceiling. A version-40 QR code - the largest there is - holds 2,331 bytes in byte
mode at error-correction level M and 2,953 at level L, and `chooseErrorCorrectionLevel` takes the
more robust of the two that fits (`src/link/qrCapacity.ts`). Measured against the real
QuestionnaireResponse fixtures, deflate plus base64url lands the link at roughly a fifth to a half
of the raw JSON, improving as responses get larger, so the practical limit is about 14 KB of raw
answers. Past that the QR is refused and the link still works: the surface falls back to copying it.

Compression is the browser's native `CompressionStream('deflate-raw')`, so there is no pako or
fflate dependency. It needs Chrome 80, Safari 16.4 or Firefox 113 - a browser too old for it cannot
build the fallback link, and says so rather than producing a broken one.

Two properties of the fragment are worth remembering, because they still shape the app:

1. **Privacy:** a fragment is never sent in an HTTP request, so a link pasted into `/view` never
   reaches any server, including ours.
2. **Routing:** the fragment is unavailable for routing, so the app uses `BrowserRouter` and the
   server needs an SPA rewrite, or `/view` 404s on refresh. See [Deploying](#deploying).

## One server, one authority

This is the section that used to be called "Three servers, three jobs", and the change is the point
of the whole feature. There were three servers because the app had no launch context and had to be
told where everything was: a forms catalogue to read definitions from, an EHR to read patients and
write responses to, and a blob host to park ciphertext on. Keeping them apart was most of what the
configuration did.

There is now one, and it is not configured:

|                          |                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **The launched server**  | Questionnaires, patients, responses and request tasks. Read and written, with the authority the launch granted |
| **The BFF**              | Hosts its own SHL manifests, mints grants, holds every secret. Same process that serves the SPA                |
| **A terminology server** | ValueSet expansion, passed straight through to the renderer. The only remaining URL in `config.json`           |

The forms server is gone because a shared public catalogue was never the right answer for a signed-in
user: the forms you should see are the forms your own organisation publishes. The blob host is gone
because the component that mints is now the component that hosts, which removes a third party from
the trust story and, incidentally, the defect that made minted links unopenable in conformant wallets
(see [`docs/u-flag-hosting.md`](docs/u-flag-hosting.md)).

What replaces the configuration is the **issuer registry**: the list of servers this deployment is
registered with, held server-side. Adding a server is a configuration change; it is not something a
browser can be pointed at.

### Sent requests come from one place now

`/requests` is one query: the request tasks published on the launched server, searched back out by
tag.

It used to be a union of those tasks and a browser-local store, and the reason is worth recording
because it is exactly the complexity that went. The server knew every request; the browser knew the
reply keys, because a key was generated at mint time and stored nowhere else. So a request sent from
a colleague's machine was visible but not collectable, and the list had to explain that.

Nothing needs explaining now. Answers land directly on the launched server, so a request's state
_is_ the state of its Task, and everybody signed in to that server sees the same thing. There is no
local key to hold, nothing to export between browsers and nothing to poll.

One thing the published task still deliberately drops: **`Task.focus`**. The invitation names the
Questionnaire by canonical, because that is the only form of the reference a filler can still use
once the Bundle is taken apart - but `focus` is a `Reference`, and a FHIR server will not store a
canonical in one:

```
Invalid resource reference found at path[Task.focus]
 - Resource type is unknown or not supported on this server
 - http://example.org/Questionnaire/detection|1.2
```

So the server copy relies on `input[].valueCanonical`, which is a `canonical` rather than a
`Reference` and stores fine. `check:roundtrip` asserts it, because reinstating `focus` makes every
request creation fail.

## Configuration

Configuration is split by who is allowed to see it. The browser gets a small file with nothing
sensitive in it; the server gets an environment and a registry.

### The browser's runtime config

Fetched from `/config.json` at boot - the same pattern as `apps/smart-forms-app` in the smart-forms
monorepo - so **one build can be deployed against different environments without rebuilding**. The
file lives at `public/config.json` in the repo and lands at `dist/config.json` in a build, where it
can be edited in place.

This is what ships, in full:

```json
{
  "terminologyServerUrl": "https://r4.ontoserver.csiro.au/fhir",
  "linkBaseUrl": null,
  "senderName": null,
  "linkLifetimeDays": 30
}
```

|                        |                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terminologyServerUrl` | ValueSet expansion, passed straight through to the renderer. The one service that is still separately configured                                                                                                                                       |
| `linkBaseUrl: null`    | use `window.location.origin`. Set it when the device opening the link cannot resolve that origin - a phone scanning a laptop's QR, or a reverse proxy on a different host                                                                              |
| `senderName`           | fallback for `Task.requester.display`. A launched session normally knows who is signed in and uses that; this covers a launch that disclosed no user, which is legal. An invitation that cannot say who sent it is one a patient has reason to decline |
| `linkLifetimeDays`     | sets the link's `exp`. `null` for no expiry. Independent of the grant lifetime, which is much shorter                                                                                                                                                  |

Note what is **not** here: no FHIR server, no write target, no blob host, no channel flags and no
codec choice. There is nothing left to configure about which server holds the data, because the
answer is always "the one you launched from"; and nothing left to configure about how a link is
built, because each end has exactly one option.

### The server's environment

`.env.example` is authoritative and annotated; read it rather than this table, which exists to say
what the groups are for.

|                         |                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`, `PORT`    | where the app is served from, and where it listens. `APP_ORIGIN` is what the OAuth redirect URI is built on, so it has to be the origin the browser actually used |
| `SQLITE_PATH`           | one file, holding sessions and invitations                                                                                                                        |
| `ISSUER_REGISTRY_PATH`  | the JSON registry described below                                                                                                                                 |
| `SESSION_COOKIE_SECRET` | signs the `shl_session` cookie. At least 32 characters                                                                                                            |
| `LAUNCH_CLIENT_SECRET`  | the confidential launch client's secret, referenced by name from the registry                                                                                     |
| `BACKEND_PRIVATE_JWK`   | the Backend Services RS384 signing key, one line of JWK JSON, referenced by name from the registry                                                                |
| `AIDBOX_*`              | used only by `ops/aidboxSetup.ts` and the acceptance suite. The running app never reads them                                                                      |

The two credential variables are referenced from the registry rather than read directly, which is
what lets a deployment register several servers with different credentials without the variable names
being baked into code.

### The issuer registry

A JSON array of the servers this deployment is registered with. `config/issuers.example.json` is the
template and the authoritative shape:

```json
[
  {
    "issuer": "https://kuzfdswqmz.edge.aidbox.app/fhir",
    "label": "Aidbox demo",
    "launchClient": {
      "clientId": "smart-forms-health-links",
      "clientSecret": "env:LAUNCH_CLIENT_SECRET",
      "scopes": "openid fhirUser launch launch/patient online_access user/*.cruds"
    },
    "backendClient": {
      "clientId": "smart-forms-health-links-backend",
      "privateKeyJwk": "env:BACKEND_PRIVATE_JWK",
      "scopes": "system/QuestionnaireResponse.c system/Provenance.c system/Task.r system/Task.u"
    },
    "grantTtlSeconds": 3600
  }
]
```

Two clients per server, and they are not interchangeable:

- **`launchClient`** is the confidential client the requester's browser is launched through. Its
  authority is the signed-in user's, and it is what every requester read and write uses.
- **`backendClient`** is the SMART Backend Services client the manifest route mints grants with. Its
  authority is the system's, which is why its scope is the narrowest the writeback can work with -
  create a response, create a provenance, read and update a task, nothing else - and why the token
  it produces is short-lived.

**Secret-bearing fields hold `env:VARIABLE_NAME`, never a value.** The registry is a configuration
file that can be committed, mounted from a ConfigMap or checked into a deployment repo; the values it
names come from the environment. A registry that inlined a secret would put one wherever the registry
went.

`grantTtlSeconds` is the stated lifetime of a minted token, per issuer, defaulting to one hour. It is
independent of `linkLifetimeDays` on purpose - see [the grant](#the-grant-and-why-it-is-minted-per-fetch).

An `issuer` that is not in this registry is refused at launch, by name, with nothing stored and no
credential sent anywhere. That refusal is the whole security boundary of the launch leg: `iss` is a
URL an attacker controls, and treating it as a discovery target would have the app send its client
secret to whoever asked.

### What happens when config is missing

The two halves fail differently, and deliberately so.

**The browser's `config.json`** is not load-bearing any more. A missing or malformed file falls back
to the shipped defaults - the public CSIRO terminology server, no link base override, a thirty-day
link lifetime. Nothing about where data goes depends on it, so there is nothing to guess wrongly.

**The server's configuration is load-bearing and fails loudly.** A missing environment variable, a
registry that does not parse, an `env:` reference to a variable that is not set, a private JWK that
is not an RS384 key, a session secret that is too short: each stops the process at startup with a
message naming the field and the entry. There is no partial mode. A server that started without a
registry would have no way to refuse an unregistered issuer.

## Deploying

The app is a single Node process serving the built SPA and the API from one origin. It is no longer a
static site: the API, the manifest hosting and the session all need a server.

```bash
npm run build          # tsc -b && vite build  ->  dist/        (the SPA)
npm run build:server   # esbuild               ->  dist-server/index.mjs
node dist-server/index.mjs
```

`build:server` bundles with `--packages=external`, so `node_modules` has to be present at runtime.
That is not incidental: `better-sqlite3` is a native module and cannot be bundled.

### Docker

A multi-stage `Dockerfile` builds both halves on `node:22` and runs them on `node:22-slim` as a
non-root user, exposing port 3000 with a `HEALTHCHECK` on `GET /health`.

One detail in it is load-bearing and easy to undo: the entrypoint is `tini`, not `node`. Node
installs no `SIGTERM` handler of its own, and a process running as PID 1 ignores signals whose
disposition is the default - so without an init the container never shuts down on request. It waits
out the full grace period and is then killed, which measured as 33 seconds per rollout against 3
with `tini` in place.

### Helm

`helm/smart-forms-health-links/` deploys it:

```bash
helm upgrade --install shl helm/smart-forms-health-links \
  --set smartFormsHealthLinks.ingress.host=shl.example.org
```

Five things about the chart are worth knowing before changing it:

- **One replica, `Recreate` strategy.** The state is a single SQLite file on a `ReadWriteOnce` PVC
  mounted at `/data`. Two replicas would be two databases behind one Service, so sessions and
  invitations would resolve or not depending on which pod answered.
- **The registry is a ConfigMap**, rendered from the `smartFormsHealthLinks.issuers` values key and
  projected read-only into the pod. It is safe there because its secret-bearing fields are `env:`
  references.
- **Secrets are never templated.** Create a Kubernetes Secret yourself and name it in
  `smartFormsHealthLinks.existingSecret`; the pod picks it up with `envFrom`, so its keys have to be
  exactly the variable names - `SESSION_COOKIE_SECRET`, `LAUNCH_CLIENT_SECRET`,
  `BACKEND_PRIVATE_JWK`, and anything else the registry references.
- **`APP_ORIGIN` is derived from the ingress host** and its TLS setting, and can be overridden with
  `smartFormsHealthLinks.appOrigin`. Rendering fails if neither is set, because a wrong `APP_ORIGIN`
  produces a redirect URI the authorisation server will reject and no earlier signal than a failed
  launch.
- **All three probes are `GET /health`** on container port 3000 - startup, liveness and readiness.
  That route deliberately says nothing about configuration, so it cannot be used to discover whether
  a registry loaded.

`helm/smart-forms-health-links/README.md` documents the values.

### HTTPS is not optional

The session cookie is `Secure`, the camera on `/scan` needs a secure context, and so does the Web
Crypto used for every link. None of it works over plain HTTP off `localhost`. The authorisation
server will also refuse a plain-HTTP redirect URI.

## Repo layout

```
server/                  the BFF: Fastify, one origin, every secret
  index.ts               routes, the SPA fallback, log redaction
  config.ts              environment plus the issuer registry, validated at startup
  db.ts                  the SQLite schema; sessions and invitations
  sessions.ts sessionCookie.ts
  smart/
    launch.ts            GET /launch and GET /auth/callback
    confidentialClient.ts  code exchange and refresh, client_secret_basic
    backendServices.ts   signed-assertion token minting, and the public JWKS
    discovery.ts         .well-known/smart-configuration
    sessionAuthority.ts  the token a proxied request is made with
    requesterDisplay.ts  who an invitation says it is from
  api/
    session.ts           GET /api/session, POST /api/logout, GET /api/issuers
    fhirProxy.ts         ALL /api/fhir/*
    invitations.ts       POST /api/invitations
  shl/
    invitationStore.ts   the hosted payload behind a shlink: URL
    manifest.ts          POST /shl/:id, and the per-fetch grant
src/                     the SPA
  App.tsx                routes, the session gate, the root-fragment forward
  routes/                Connect, FormList, RequestForm, Requests, ResponseList,
                         PatientList, FillForm, ViewLink, Scan
  components/
    FormRenderer.tsx     the smart-forms-renderer composition
    FillFromRequest.tsx  the filler's fallback: render, then return a link
    ReviewResponse.tsx   the requester's side: read-only review, then write
    PatientPicker.tsx    inline patient search
    RawAnswers.tsx       the fallback table when a Questionnaire cannot be resolved
    ShareLinkPanel.tsx   QR + copyable link
  fill/
    directSend.ts        the submission transaction, and sending it
    DirectSendPanel.tsx  what the filler sees: disclose, confirm, terminal state
  link/
    codec.ts             the LinkCodec interface, and decoding across codecs
    shlCodec.ts          shlink:/  - hosted and encrypted; invitations
    bespokeCodec.ts      sfhl:/    - inline and unencrypted; the filler's return
    apiAccess.ts         the grant file: building, parsing, expiry
    createLink.ts        asks the BFF to mint; builds the filler's return link
    invitationBundle.ts  the invitation and response Bundles
    exchange.ts          resolves a link into something renderable
    jwe.ts               alg:dir + A256GCM
    replyCrypto.ts       ECDH-ES + A256GCM, P-256 - inbound reply channels only
    replyDescriptor.ts   parsing another producer's declared return channel
    qr.ts qrCapacity.ts binary.ts registry.ts
  fhir/
    formsServer.ts       Questionnaire search and resolve-by-canonical, via the proxy
    ehrServer.ts         patients, responses, published request Tasks, via the proxy
    submit.ts            the scan-back write: endpoint resolution, meta, Provenance
  lib/
    config.ts            AppConfig, validation, and the fallback
    session.ts           the session query, the requester gate, the proxy fetch
    answerRows.ts        flattening a QuestionnaireResponse for RawAnswers
ops/
  aidboxSetup.ts         npm run setup:aidbox - idempotent clients, policies, demo data
tests/                   vitest: tests/server, tests/src, tests/ops
e2e/                     playwright: the two-window acceptance suite
scripts/
  roundtrip.ts           npm run check:roundtrip - no network
  e2eShl.ts e2eLink.ts   live checks against a FHIR server
config/issuers.example.json  the issuer registry template
public/config.json       the browser's runtime config
Procfile                 dev: vite + server watch, under overmind
Dockerfile
helm/smart-forms-health-links/
docs/
  aidbox-validation.md        the two-window walkthrough on the validation instance
  shl-form-reply-channel.md   the reply channels: design record, and what is still minted
  response-links.md           what counts as an inbound response link, plus the token channel
  u-flag-hosting.md           the U-flag hosting defect, and what closed it
```

## Known limitations

### A minted token is not bound to its invitation

This is the accepted risk of the whole design, and it is worth stating first because it is the one
that would matter in a real deployment.

The grant carries a SMART Backend Services token whose authority is the _system's_, narrowed by
scope. Within that scope and that lifetime it could create a response for some other invitation, or
update some other task, on the same destination. Nothing in the token says which invitation it
travelled in.

Four things bound it, none of which eliminates it:

- **The scope is the minimum the writeback needs** - create a response, create a provenance, read and
  update a task. It cannot read patients, cannot read other responses and cannot touch anything else.
- **The lifetime is short and configurable**, defaulting to one hour.
- **Minting is per fetch**, so the window starts when the link is opened rather than when it was
  minted, and a link that is never opened never produces a token at all.
- **Every mint is at the authorisation server**, so there is an audit trail of exactly which
  credentials were issued and when.

Invitation-bound tokens - a token the destination will only accept for one request identifier - are
out of scope here. They need something on the server side that this app cannot assume.

### Anyone who photographs a link can mint tokens from it

An invitation is usually a QR code, so a bystander who photographs it holds the key and the manifest
URL, and can fetch that manifest and obtain a token, repeatedly, until the link expires. They can
also read the questionnaire and the patient's name.

That is the same exposure any `U`-flag SHL has for its payload, extended to the credential. It is the
reason the token lifetime is short and independent of the link lifetime, and the reason a deployment
that cannot accept it should set `grantTtlSeconds` low and `linkLifetimeDays` lower.

### A replayed send leaves two provenances

Send the same answers twice and the destination ends up with one response and one completed task -
both are keyed - but **two `Provenance` resources**.

The response is a conditional create on the request identifier and the task is a versioned `PUT`, so
both are idempotent. The provenance is a plain `POST`, because the wire contract defines no
conditional-create key for it, and inventing one here would produce a transaction the Platypus
direct-send implementation does not expect. Interoperability won: two provenances describing the same
assertion are untidy, and a contract that only one implementation follows is worse.

### Single replica only

The state is one SQLite file: sessions and invitations. Two replicas would be two databases behind
one Service, so a browser's session or a filler's manifest fetch would resolve or not depending on
which pod answered. The Helm chart pins `replicas: 1` with a `Recreate` strategy for that reason,
which also means a rollout has a gap in it.

### The fallback link is not encrypted

The scan-back return deflates the answers into the URL fragment. That is compression, not
protection: anyone who photographs the QR code or reads the URL can decompress it.

Two things narrow it. A fragment is never sent in an HTTP request, so the answers never travel to
any server, including this one - the requester's browser decodes them locally. And the surface says
so, at the point where the link is produced, rather than implying a confidentiality it does not have.

It is still weaker than what it replaced. The old fallback encrypted the payload under a fresh key
carried in the link, and parked the ciphertext on a public sandbox FHIR server - which is precisely
the third-party dependency this feature removed. Restoring encryption without restoring that
dependency means giving the filler somewhere to put a file, and the only candidate is an anonymous
write endpoint on the server that holds every secret. That trade was declined.

### Other limitations, by design or otherwise

- **Minted links carry no passcode.** Manifest mode makes one structurally possible, unlike the `U`
  flag it replaced, but nothing implements it. Reading a passcode-protected manifest works.
- **A `U`-flag `GET` of somebody else's link omits the `recipient` parameter the spec requires**, so
  a host that insists on it will refuse. That is the inbound half of the defect in
  [`docs/u-flag-hosting.md`](docs/u-flag-hosting.md); the outbound half closed when hosting moved
  in-process.
- **The BFF can decrypt its own invitations**, because it keeps the link key to encrypt grant files
  with. An SHL host is conventionally blind; this one is not, and the trade was made knowingly
  against multi-day tokens.
- **No token revocation.** Deleting an invitation stops further mints, but a token already minted
  lives out its stated lifetime unless the authorisation server can revoke it.
- **Answers arriving by direct send are not reviewed by a human** before they are stored. They are
  the patient's own answers and are labelled `PATAST` with a `Provenance` saying so, which is the
  honest representation, but it is a different posture from the scan-back path.
- **The fallback link has a size ceiling of roughly 14 KB of raw answers**, because it has to fit a
  version-40 QR code. Past that the link still works but cannot be scanned, only copied - which on a
  phone means the patient has to get a URL to the clinic some other way.
- **The demonstration instance is a shared sandbox.** Do not put anything real in it.

## Checks

```bash
npm run typecheck        # tsc project references
npm run lint             # eslint
npm run test             # vitest: tests/server, tests/src, tests/ops
npm run build            # tsc + vite build
npm run build:server     # esbuild bundle of the BFF
npm run check:roundtrip  # codecs, JWE, reply crypto, foreign links, passcodes - no network
npm run check:e2e-shl    # the manifest and grant contract over real HTTP
npm run check:e2e        # the inline codec against a live questionnaire catalogue
```

`npm run test` is the one to run on every change. It covers the server end to end through Fastify's
`inject` - launch, callback, session, proxy, mint, manifest - without binding a port, and the
browser-side contracts as units: the grant's tolerance rules, the submission transaction's shape, the
send state machine, the invitation Bundle, and the disclosure the filler view has to make before a
send.

`check:roundtrip` needs neither network nor hosting. It covers the crypto properties that matter - a
wrong key, a tampered ciphertext and a tampered `epk` must all fail, and an `alg: dir` header must be
refused where `ECDH-ES` is required - plus the SHL codec against an in-memory store. Four sections
are worth knowing about:

- **Cross-implementation crypto vectors.** The reply crypto is checked against an independent
  `node:crypto` implementation _in both directions_, transcribed from Platypus's own
  `scripts/shl-invite.mjs`. A self-consistent implementation of the wrong Concat-KDF passes its own
  round trip perfectly and cannot talk to anyone; only a second implementation catches that.
- **The Platypus detection contract.** `questionnaireRefFromTask` and `taskTargetsQuestionnaire` are
  ported verbatim and run against a freshly built request, so a change to how the Task names its
  Questionnaire cannot silently stop a third party recognising our invitations. The negative case is
  asserted too - the `focus.type`-without-canonical half-change must _not_ be detectable - because
  the positive checks alone would prove nothing.
- **Attribution on write.** That `meta.security` survives, that `versionId`/`lastUpdated`/`id` do
  not, and that a `Provenance` is retargeted to the real response id.
- **The shipped config names no data server.** A regression that reintroduced a configured write
  target would reintroduce anonymous mode, so it fails a check rather than a review.

The two `check:e2e*` scripts are command-line processes with no SMART launch, so neither can obtain
a session and neither writes to any FHIR server. What they add over the unit tests is realism on the
parts a unit test cannot fake. `check:e2e-shl` serves a manifest over real HTTP from a throwaway
localhost server and makes the filler's own `POST`, so real compression, real AES-GCM, real `cty`
dispatch and real JSON all have to line up for a link this app mints to open in somebody else's
reader. `check:e2e` exercises the inline codec against a live questionnaire catalogue, which is the
path the fallback return depends on.

### The acceptance suite

```bash
op run --env-file .env -- npm run test:e2e
```

That is the whole command: `test:e2e` builds the SPA first, and the Playwright config's `webServer`
starts the BFF - reusing one already listening on `APP_ORIGIN`, which is the usual case when
`overmind start` is running. Reuse means the server process is whatever was already started, so
restart it before trusting a pass on a change under `server/`.

Two browser contexts, against the configured server: launch both ways, mint, manifest fetch, direct
send, and the server-side end state asserted with operator credentials. It also covers the
unregistered-issuer refusal and the idempotent re-send. What it proves, and how to run the same thing
by hand, is in [`docs/aidbox-validation.md`](docs/aidbox-validation.md).

### `check:roundtrip` needs a sibling smart-forms checkout

It imports three real QuestionnaireResponse fixtures by relative path, so it will not run without
one:

```bash
git clone https://github.com/aehrc/smart-forms.git ../smart-forms   # no install needed
```

The imports are static and resolved by esbuild at bundle time, so a missing checkout is a build error
rather than a skipped section. Nothing else in the repo has any coupling to the monorepo: the app
depends only on `@aehrc/smart-forms-renderer` from npm.

Not covered by any of these:

- **A third-party wallet opening a link this app mints.** The contract is pinned against Platypus's
  conformance vectors as fixtures, which is not the same as two running systems.
- **The UI's appearance.** The acceptance suite drives it; nothing asserts how it looks.

## Notes

- **The browser never holds a credential, and the log never holds one either.** The error handler
  answers with a stable code rather than the error's own text, and the logger redacts every field
  that could carry grant material. Minted access tokens are not persisted at all: they are minted,
  encrypted into the grant file and forgotten.
- **Referential integrity will reject foreign subjects - and for answers from another app this is
  the normal case, not an edge case.** A third-party filler names the patient in _its_ terms, so a
  response naming a patient the destination does not hold fails the whole write. `ReviewResponse`
  probes the subject against the destination _before_ enabling Accept and offers reconciliation,
  including a search of that destination, since a reference is only worth anything on the server it
  will be stored on. The subject is never silently stripped to force the write through - that would
  lose who the answers are about, and clearing it is an explicit, labelled choice. Picking a patient
  replaces the foreign `display` rather than merging it, because a name the filler's system chose
  does not describe the record the reviewer just pointed at.
- **Answers naming _no_ patient are the quieter half of the same problem.** An unresolvable subject
  at least fails loudly. A response with no `subject` is accepted by every server and files the
  answers against nobody, permanently, so it is asked about just as loudly. On the direct-send path
  the grant decides this: no `patient` in the grant means no subject on the response, rather than a
  filler-local reference that would mean nothing on the destination.
- **The scan-back path never writes without review.** `ReviewResponse` renders read-only on purpose:
  editing another party's answers before committing them would blur who recorded what and make the
  response's `author`/`source` describe a document that no longer exists.
- **A foreign `id` is stripped before writing, but not the whole of `meta`.** A response from another
  app carries identity from _its_ server, so `id`, `meta.versionId`, `meta.lastUpdated` and
  `meta.source` go. `meta.security`, `meta.tag` and `meta.profile` **stay**. Dropping `meta`
  wholesale is the obvious reading of "strip foreign identity" and it silently discards the `PATAST`
  patient-asserted label, filing answers a patient typed on their phone as though a clinician had
  recorded them. Any accompanying `Provenance` is written too, retargeted from its `urn:uuid` to the
  created response.
- **`ifNoneExist` casing is exact.** Aidbox is case-sensitive about the field, so a transaction that
  spells it otherwise silently loses its idempotence and creates a second response.
- **Development does not run Vite's dev server, and the reason is the session cookie.** `/launch`
  builds its
  `redirect_uri` from `APP_ORIGIN` and the authorisation server is registered against that exact
  callback, so the browser always comes back to the BFF's origin and the cookie is set there. A dev
  server on a second port proxying the API would leave you looking at an origin that is not signed
  in, which fails in ways that read like session bugs. Hence `vite build --watch` in the `Procfile`:
  rebuild-on-save, one origin, no HMR. `APP_ORIGIN` has to match the origin the browser actually
  used, for the same reason.
- **Camera:** scanning needs a secure context. `localhost` qualifies; opening the app by LAN IP from
  a phone does not - use HTTPS or a tunnel. There is a paste fallback on `/scan`.
- **Two style systems:** the shell is Tailwind, the form is MUI. MUI is a hard dependency of the
  renderer, so it ships either way; `apps/demo-renderer-app` upstream makes the same trade.
- **Renderer API:** `SmartFormsRenderer` is deprecated upstream. This app uses the supported
  `useBuildForm` + `RendererThemeProvider` + `BaseRenderer` composition. Note that `useBuildForm`
  takes a params object - the positional signature in upstream's `demo-renderer-app` is stale.
- **npm, not bun.** The house preference is bun; this repo stayed on npm because swapping it would
  touch the lockfile, every script, the Dockerfile and the docs for no feature value.

## Provenance

A demonstrator from [AEHRC](https://aehrc.csiro.au/), CSIRO's Australian e-Health Research Centre,
built on the same renderer as [smart-forms](https://github.com/aehrc/smart-forms) and designed to
interoperate with [Platypus](https://github.com/aehrc/platypus). It depends on
`@aehrc/smart-forms-renderer` from npm only, so it tracks published releases rather than the
monorepo's `main`.

It is a demonstrator: it exists to show that the round trip works and to pin down the wire formats in
[`docs/`](docs) precisely enough for someone else to implement against. It is not a supported
product.

## Licence

Apache License 2.0 - see [`LICENSE`](LICENSE). The same licence as
[smart-forms](https://github.com/aehrc/smart-forms).

Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation (CSIRO) ABN 41 687
119 230.
