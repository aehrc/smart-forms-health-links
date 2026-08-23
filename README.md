# Smart Forms Health Links

Ask someone to fill out a FHIR questionnaire by handing them a scannable
[SMART Health Link](https://docs.smarthealthit.org/smart-health-links/), let them complete it on
another device with no access to your servers, then review the answers and write them to your own
FHIR server.

Built on [`@aehrc/smart-forms-renderer`](https://www.npmjs.com/package/@aehrc/smart-forms-renderer)
from npm — the app has no build-time coupling to the
[smart-forms](https://github.com/aehrc/smart-forms) monorepo. (One dev-only check script imports test
fixtures from a sibling checkout; see [Checks](#checks).)

```bash
npm install
npm run dev          # http://localhost:5273
```

It works against public sandbox servers with no configuration, so a clone completes the whole round
trip out of the box. **This is a demonstrator, not a product** — see
[Known limitations](#known-limitations) before showing it to anybody, because the links it mints
cannot currently be opened by third-party SHL wallets.

## Contents

- [What this demonstrates](#what-this-demonstrates)
- [Quick start](#quick-start) — install, then walk the round trip end to end
- [What it does](#what-it-does) — the routes
- [The round trip](#the-round-trip) — ten steps, with measured sizes
- [Three ways to return answers](#three-ways-to-return-answers) — and why A is the default
- [How links work](#how-links-work)
- [Two transports, one interface](#two-transports-one-interface)
- [Three servers, three jobs](#three-servers-three-jobs)
- [Configuration](#configuration)
- [Deploying](#deploying)
- [Repo layout](#repo-layout)
- [Known limitations](#known-limitations)
- [Checks](#checks)
- [Notes](#notes) — the gotchas worth knowing before changing anything
- [Provenance](#provenance)
- [Licence](#licence)

## What this demonstrates

The repo exists to make six claims concrete, each of which is either non-obvious or contradicted by
how SHL is usually described:

1. **A whole FHIR Questionnaire fits in a QR code** — by reference, not by value. The GP Chronic
   Condition Management Plan is 111 KB of JSON; the link that carries it is **271 bytes**, because
   the form is encrypted, hosted, and named by a URL plus a key.
2. **The filler needs no access to the requester's servers.** Everything required to render and
   complete the form travels inside the encrypted payload. No login, no launch context, no network
   path back to the EHR.
3. **Answers can come back over SHL without going off-spec.** SHL is strictly one-directional and
   defines no upload channel — so the return leg is *another SHL*, minted by the filler and scanned
   by the requester, who performs the write themselves. See
   [Three ways to return answers](#three-ways-to-return-answers).
4. **A human reviews before anything is stored.** Answers arrive, get rendered read-only, and are
   written only on accept. The one channel that skips review is off by default and labelled as such.
5. **Reading a link somebody else wrote is the hard part**, and it is where a strict implementation
   quietly loses data — bare resources instead of Bundles, multi-file manifests, passcode prompts,
   unresolvable questionnaire canonicals. Each of those is legal SHL and each is handled. See
   [Reading a link this app did not write](#reading-a-link-this-app-did-not-write).
6. **No new infrastructure is required.** An untrusted FHIR `Binary` endpoint is enough to host an
   SHL payload, because the payload is a JWE and the key travels only in the link. There is no S3
   bucket, no lambda, no manifest service. This is the claim with the outstanding hole in it: a HAPI
   `Binary` rejects the `recipient` parameter the spec requires on a `U`-flag fetch, which is why
   third-party wallets cannot open these links yet. See [Known limitations](#known-limitations).

It also serves as a worked example of interoperating with
[Platypus](https://github.com/aehrc/platypus): its detection contract and its reply crypto are both
reimplemented here and checked against transcriptions of its own code.

## Quick start

### Prerequisites

| | |
| --- | --- |
| Node | **22 or newer** (Vite 6 and the check scripts target `node22`) |
| npm | ships with Node |
| A browser | any current one; the scanner needs camera access and a secure context |
| A FHIR server | **not required** — the defaults point at public sandboxes |
| A sibling `../smart-forms` checkout | only for `npm run check:roundtrip`, which imports fixtures from it. Not needed to run the app |

```bash
git clone https://github.com/aehrc/smart-forms-health-links.git
cd smart-forms-health-links
npm install
npm run dev
```

Open <http://localhost:5273>. You should see a searchable list of Questionnaires read live from
`smartforms.csiro.au`. If that list is empty the forms server is unreachable, and nothing else will
work either — check it directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://smartforms.csiro.au/api/fhir/metadata
```

### Walk the round trip

The whole point of the app is a loop between two devices, so it is worth walking it once. Do the
**one-machine variant first** — it needs no setup at all — then the two-device one if you want to
demo the QR codes.

#### One machine, two windows (nothing to configure)

1. **Pick a form.** On `/`, search for something small to start with — `sepsis` or
   `medications` — and click **Request** on a result. (`Fill` is the shortcut that skips the
   request leg and just fills the form yourself.)
2. **Say who it is for.** Optional, but worth doing. Search the EHR for the patient and click them
   to fill both fields correctly, which also makes step 8 succeed without reconciliation. The two
   fields underneath still take a reference typed by hand, for a server the app cannot search.
3. **Create request link.** The app encrypts the entire Questionnaire plus a `Task` into a JWE,
   `POST`s it as a FHIR `Binary`, and shows you a QR code and a copyable `shlink:/…` URL. It also
   publishes the `Task`, so the request now appears under **Sent requests**.
4. **Copy the link** and open it in a second browser window — ideally a different profile or a
   private window, to make the point that no shared state is involved.
5. **Fill it in.** The second window resolves nothing from your servers; it decrypts the payload and
   renders the form. Note the header: it names who asked and who it is addressed to.
6. **Return as Health Link.** The filler encrypts the answers into *its own* SHL, hosts them, and
   shows its own QR and link. Copy that.
7. **Paste it into `/scan`** back in the first window. Reading it needs no infrastructure at all.
8. **Review and accept.** The answers render read-only. The subject is probed against the EHR
   first, so a patient the destination does not hold — or answers that name no patient at all —
   surfaces as a question rather than a failed write or a silently unfiled record. Search the
   destination for the right patient there and then; the answers only exist in the browser at that
   point, so the picker is inline rather than a page you navigate to. On accept the app `POST`s the
   `QuestionnaireResponse` and the `Task`.
9. **Confirm it landed.** `/responses` lists the stored response, and the row on **Sent requests**
   flips to **Accepted** — the scanned answers are matched back to the request on `Task.identifier`,
   which is the one key that survives both copies.

#### Two devices, with the camera

Same steps, with the phone doing 5–6 and the laptop doing 7. Two things bite here:

- **The link points at `window.location.origin`**, which on the laptop is `http://localhost:5273` —
  a URL the phone cannot open. Set `linkBaseUrl` in `public/config.json` to something the phone can
  reach (your LAN IP, or a tunnel) before minting the link.
- **The camera needs a secure context.** `localhost` qualifies; the same dev server opened by LAN IP
  does not, so the phone will refuse to scan even though it can load the page. Use HTTPS or a tunnel
  (`cloudflared tunnel --url http://localhost:5273`, `ngrok http 5273`) and set `linkBaseUrl` to the
  tunnel URL. `/scan` has a paste box as the fallback on both sides.

### What the demo writes, and where

Out of the box, reads and writes go to the **CSIRO EHR sandbox** at `proxy.smartforms.io/fhir`, so
the loop works with no setup and against the same data smart-forms itself uses. Two consequences:

- Everything written there is **world-readable, shared with other CSIRO tooling, and wiped when the
  AWS instance restarts** (roughly every 60–90 days). It is for demos. Do not put anything real in
  it.
- The **forms server stays read-only**, which is the whole point of keeping the two apart.

Point `responseServerUrl` at your own server for anything beyond a demo. See
[Configuration](#configuration).

## What it does

| Route              | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `/`                | Search and list Questionnaires on the forms server                          |
| `/request/:id`     | Create an encrypted SMART Health Link containing a whole form               |
| `/requests`        | Sent requests, and their status                                             |
| `/responses`       | QuestionnaireResponses already stored on the EHR, read-only                  |
| `/patients`        | Patients on the EHR — pick a request's subject, or filter responses          |
| `/fill/:id`        | Fill a form directly and emit a Health Link from the answers                |
| `/view#<link>`     | Open any link — **dispatches on payload**: fill a request, or review a response |
| `/scan`            | Read a QR with the camera, or paste a link — **how answers come back**       |

`/view` deliberately decides what to show from the payload rather than the route, because a scanner
cannot know whether it just scanned a request or a completed response. A link fragment arriving at
the site root is forwarded to `/view` too, since `https://viewer.example.org#shlink:/…` is the
conventional shape.

## The round trip

```
REQUEST   requester hosts, real shlink:/
  1. pick a Questionnaire, mint Task{status:requested, focus:Q, for:Patient}
  2. Bundle{Questionnaire, Task} -> JWE (alg:dir, enc:A256GCM)
  3. POST /Binary                -> https://…/api/fhir/Binary/{id}
  4. shlink:/{url, key, flag:"U"}   ~271 bytes, fits a QR

FILL      any device, no access to the requester's servers
  5. GET the blob -> decrypt -> render -> fill
  6. Bundle{QuestionnaireResponse, Task{status:completed, output -> response}}

RETURN    the filler mints its own shlink:/ and the requester scans it back
  7. Bundle -> JWE -> the filler's own storage -> shlink:/ -> QR
  8. requester scans or pastes it; reading needs no infrastructure
  9. HUMAN REVIEWS the answers, read-only
 10. on accept: POST /QuestionnaireResponse + POST /Task
```

Measured on the live server for the GP Chronic Condition Management Plan:

| | bytes |
| --- | --- |
| Questionnaire | 111,319 |
| Encrypted blob (hosted) | 149,521 |
| **The link itself** | **271** |
| Return payload (no Questionnaire) | 1,119 |

## Three ways to return answers

**SMART Health Links are strictly one-directional.** Neither the
[SHL spec](https://docs.smarthealthit.org/smart-health-links/spec/) nor the
[HL7 links-specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html)
defines any submission, upload or writeback channel, and neither mentions questionnaires or requests
for data at all. Using an SHL as a *return* transport is off-spec.

The answer is that nothing off-spec is needed, because **the requester's own app performs the write**:
a filler publishes a link, this app pulls it, shows a human, and only then writes to its own server.
Answers travel the same way the request did — as a SMART Health Link, in the direction SHL already
supports — and the return leg is just another scan.

| | A · return a link | B · write to our server | C · encrypted reply |
|---|---|---|---|
| Who it suits | anything that can mint a link and show a QR | a filler that can reach our server | a filler that cannot get a QR back to us |
| Needs from us | nothing | a writable FHIR endpoint | somewhere to `PUT` a file |
| Reviewed before it lands? | yes | **no** | yes |
| Host sees answers? | no, ciphertext only | yes — it is the record | no, ciphertext only |
| Default | **on** | off | off |

**A is the primary channel**, and it is the one [Platypus](https://github.com/aehrc/platypus) uses:
the form is filled there, Platypus mints its own `shlink:/` carrying the QuestionnaireResponse, and
the requester scans it back into `/scan`. Nothing has to be arranged in advance, so a request that
offers it carries no extra fields at all — the invitation is just the form. What this app has to be
good at is *reading* a link it did not write; see below.

The honest cost is that A needs the requester physically able to scan something back. That is exactly
what C exists for, and why C is deferred rather than deleted.

**C is implemented, tested, and off by default** (`enableEncryptedReply`). A reply slot is minted
alongside the request and the answers come back encrypted to a key that never leaves this browser.
Turn it on when a filler may have no way to show you a QR code. Note the asymmetry: the flag governs
only what this app *mints*. A request from a third party that offers a reply descriptor is still
answerable here regardless, because refusing to honour someone else's return channel would strand
their answers rather than protect anyone.

**B is opt-in and does not preserve the review posture.** It declares `sdc-questionnaire-endpoint` on
the form and publishes the request's `Task`, so a filler holding nothing but the link can `POST` a
response straight into the configured server. That is ordinary SDC and needs no infrastructure, but
the answers arrive unreviewed and the endpoint must accept anonymous writes. Point it at a staging
server if you want both. Off unless `enableServerReturn` is set.

The wire format for B and C is specified in [`docs/shl-form-reply-channel.md`](docs/shl-form-reply-channel.md);
what this app accepts as an inbound response link is in [`docs/response-links.md`](docs/response-links.md).
Both are written so a third party can implement against them without reading this source.

### Reading a link this app did not write

Since the return leg is now somebody else's link, decoding is deliberately tolerant in four ways.
Each of these describes a link that is entirely legal and that a stricter reader rejects or silently
truncates:

- **A bare resource, not just a Bundle.** An SHL manifest file is `application/fhir+json` — any FHIR
  resource. A filler that parks a bare `QuestionnaireResponse` has done nothing wrong, so it is
  normalised into a Bundle rather than refused.
- **Every FHIR file in a manifest, merged.** A payload split across files — the answers in one, the
  `Provenance` attributing them in another — is one payload, not a choice between them. Taking only
  the first would drop the `PATAST` attribution that makes a reply safe to store. Content types are
  matched after stripping any `;charset=…`.
- **A passcode prompt, not a dead end.** A `P`-flagged link asks before it knocks: the prompt appears
  without a network round trip, because a manifest server may count a passcode-less request as a
  failed attempt and lock the link permanently. `remainingAttempts` is surfaced when the server sends
  it.
- **A raw-answers table when the form cannot be resolved.** A response cites whatever canonical the
  app that wrote it used, and on a shared server that is frequently a form this deployment's
  catalogue does not hold. That is the *expected* case, not an exceptional one. The answers are the
  clinical content and the definition is presentation, so the review still works and saving is still
  enabled.

A file that will not decrypt costs its own content, not the whole link. Anything skipped is reported
on screen rather than to the console — the only person who can judge whether a dropped file mattered
is the one reading the answers.

### Why the reply is encrypted to a public key

An invitation is usually a QR code, so anyone who photographs it holds everything inside it. A
symmetric reply key carried in the invitation would therefore let a bystander read the answers sent
back. Channel C encrypts to a **public** key (ECDH-ES + A256GCM, P-256) whose private half never leaves
the requester, so a leaked invitation can at worst destroy a reply, never read one. This follows
Platypus's design, which got this right.

The honest limit: with a reply slot hosted as a plain FHIR `Binary`, **anyone who can reach that server
can overwrite a pending reply** — and where resource ids are sequential, without even having seen the
link. They cannot read it. The descriptor reserves a `replyToken` field for hosts that can gate writes,
which needs no change to the wire format.

### And why the write itself is not novel

The write itself is not novel: `POST /QuestionnaireResponse` is core FHIR REST and exactly SDC's Form
Receiver model. SDC even specifies the destination, via
`http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint` — which this app honours
(including its "send to all listed endpoints" rule) and which smart-forms lists as unsupported.

**Correlation runs from the Task outward**, because R4 gives QuestionnaireResponse no way to point at
a Task: `basedOn` accepts only `CarePlan|ServiceRequest`, `partOf` only `Observation|Procedure`, and
`identifier` is `0..1`. So `Task.focus` names the Questionnaire, `Task.output.valueReference` names
the response, and the Task round-trips inside the Bundle. Its `identifier` is the durable key — the
`urn:uuid` references do not survive the trip, but that does.

**`Task.focus` names the Questionnaire by canonical, and this is load-bearing.** A `urn:uuid` pointing
at the Bundle entry is arguably better FHIR, and is what this shipped before — but it stops meaning
anything once the Bundle is taken apart, so a filler holding only the Task cannot say which form it
has. `focus.type` is `Questionnaire`, and the two **must change together**: readers exist that
short-circuit on `focus.type === 'Questionnaire'` and stop consulting `Task.input`, so a `type`
alongside a `urn:uuid` reference is worse than neither — it silently costs a third-party filler its
Task, its addressing and every return channel, while the form still opens. `check:roundtrip` asserts
that half-change is *not* detectable, so anyone who reintroduces it finds out here rather than at a
connectathon.

**Hosting the encrypted blob on a public server is the design, not a shortcut.** SHL assumes an
untrusted host: the file is a JWE and the key travels only in the link, so the host never sees
plaintext. That is why a FHIR `Binary` on an open server is a legitimate file host and no
S3/lambda tier is required. It is also, for a different reason, currently the thing that stops
third-party wallets opening these links — see [Known limitations](#known-limitations).

## How links work

A link carries **answers by value and the form by reference**:

```
https://host/view#sfhl:/<base64url(deflate-raw(json))>
```

The Questionnaire is never embedded — the Aboriginal and Torres Strait Islander Health Check
questionnaire alone is ~821 KB, far past what any QR code can hold. Instead the payload holds a
FHIR `collection` Bundle containing the QuestionnaireResponse, whose `questionnaire` canonical is
resolved against the forms server when the link is opened.

Measured against real QuestionnaireResponse fixtures (`npm run check:roundtrip`):

| Fixture                         | Raw JSON | Link   | QR level |
| ------------------------------- | -------- | ------ | -------- |
| QRSepsisRisk                    | 1,793 B  | 1,016 B | M       |
| QRRegularMedications            | 3,513 B  | 987 B   | M       |
| QRMedicalHistoryCurrentProblems | 6,993 B  | 1,495 B | M       |

A version-40 QR holds 2,331 bytes at error-correction level M and 2,953 at level L, so the
practical ceiling is roughly **14 KB of raw response JSON**. Past that the QR is refused but the
link still works — the UI falls back to copying it.

Compression is the browser's native `CompressionStream('deflate-raw')`; there is no pako/fflate
dependency.

### Two consequences of using the fragment

1. **Privacy:** the fragment is never sent in an HTTP request, so answers never leave the device.
2. **Routing:** the fragment is unavailable for routing, so the app uses `BrowserRouter`. Static
   hosting therefore needs an SPA rewrite (all paths → `index.html`), or `/view` will 404. See
   [Deploying](#deploying).

## Two transports, one interface

Both implement `LinkCodec` (`src/link/codec.ts`); `decodingCodec()` sniffs the prefix across every
registered codec, so links of either kind stay readable no matter which one is currently being
issued.

| | `shlink:/` (`shlCodec.ts`) | `sfhl:/` (`bespokeCodec.ts`) |
| --- | --- | --- |
| Payload | encrypted, hosted | compressed, inside the URL |
| Encryption | A256GCM | **none** |
| Hosting | required | none |
| Size limit | none | ~14 KB raw JSON |
| Third-party wallets | yes | no |
| Status | **the only codec that mints** | **decode-only** |

The SHL codec always sets the **`U` flag** — a single encrypted file fetched with a plain `GET` — so
it needs only a file host rather than a manifest service. Two honest costs: `U` cannot be combined
with `P`, so **the links this app mints have no passcode**, and they can be neither revoked nor
varied per recipient. It *reads* both hosting modes, including passcode-protected manifests, so a
filler that publishes behind a real manifest endpoint works too.

### `sfhl:/` is legacy and decode-only

Answers were compressed, not protected: anyone who photographed the QR or read the URL recovered
them. Nothing mints these any more — `encodingCodec()` refuses the codec, and setting
`"linkCodec": "bespoke"` is an error rather than a choice.

It is kept registered for decoding because links already in the wild have to keep opening, which is
the whole point of retiring a transport rather than deleting it. It existed as the only return path
open to an app with no server of its own; the SHL codec now fills that role properly.

## Three servers, three jobs

Keeping these apart is most of what the configuration is for, and conflating any two of them is the
mistake this app is shaped to avoid.

| | | |
| --- | --- | --- |
| **Forms server** | `smartforms.csiro.au/api/fhir` | Questionnaire **definitions**. Read only, never written to |
| **EHR** | `proxy.smartforms.io/fhir` | Patients and QuestionnaireResponses. Read *and* written |
| **Blob host** | anywhere | Encrypted payloads and reply slots. Need not be trusted |

The EHR is what smart-forms calls the *patient data FHIR API* and what `sdc-populate` takes as its
`sourceServerUrl`. Its sibling `proxy.smartforms.io/v/r4/fhir` is the same data behind a
[smart-launcher-v2](https://github.com/aehrc/smart-launcher-v2) facade and is the right base for an app
doing SMART App Launch — which this is not. The plain base is also the one that reports usable
`Location` headers.

Three routes read it:

| Route | Purpose |
| --- | --- |
| `/responses` | QuestionnaireResponses already stored, with a patient filter. Read-only |
| `/patients` | Pick the subject of a request, or jump to a patient's responses |
| `/requests` | Sent requests — published Tasks joined with locally-held reply keys |

### Sent requests come from two places at once

Neither source is sufficient alone, and the reason is structural. The EHR knows **every** request,
because each one publishes a `Task` (`publishRequestTasks`, on by default) tagged so it can be searched
back out. This browser knows the **keys**, because a reply key is generated at mint time and stored
nowhere else. So `/requests` merges them on `Task.identifier` — the one correlation key that survives
both copies — and a request sent from another machine shows up as visible-but-not-collectable rather
than being hidden or offered a button that could never work.

Publishing a `Task` and offering channel B are **separate settings**, and worth not conflating:
publishing only records that a request was sent; channel B additionally tells a filler to write answers
straight to that server, unreviewed.

Two things the published copy deliberately drops:

- **The reply descriptor**, so a slot URL and any write token never reach a server whose purpose is to
  be read.
- **`Task.focus`.** The invitation names the Questionnaire by canonical, because that is the only form
  of the reference a filler can still use once the Bundle is taken apart — but `focus` is a `Reference`,
  and a FHIR server will not store a canonical in one:

  ```
  HAPI-0506: Invalid resource reference found at path[Task.focus]
   - Resource type is unknown or not supported on this server
   - http://example.org/Questionnaire/detection|1.2
  ```

  So the server copy relies on `input[].valueCanonical`, which is a `canonical` rather than a
  `Reference` and stores fine — the same split the return leg already makes. `check:roundtrip` asserts
  it, because reinstating `focus` makes every request creation fail with a 400.

## Configuration

Runtime config is fetched from `/config.json` at boot — the same pattern as
`apps/smart-forms-app` in the smart-forms monorepo — so **one build can be deployed against
different servers without rebuilding**. The file lives at `public/config.json` in the repo and lands
at `dist/config.json` in a build, where it can be edited in place.

This is what ships, and it is a working demo as-is:

```json
{
  "formsServerUrl": "https://smartforms.csiro.au/api/fhir",
  "terminologyServerUrl": "https://r4.ontoserver.csiro.au/fhir",
  "linkBaseUrl": null,
  "linkCodec": "shl",
  "responseServerUrl": "https://proxy.smartforms.io/fhir",
  "blobServerUrl": "https://proxy.smartforms.io/fhir",
  "blobStore": "fhir-binary",
  "shlManifestUrl": null,
  "senderName": null,
  "enableServerReturn": false,
  "enableEncryptedReply": false,
  "linkLifetimeDays": 30,
  "publishRequestTasks": true
}
```

`check:roundtrip` asserts both that this validates and that it names write targets, because the
out-of-the-box round trip is a feature and a config edit that quietly removes it should fail a check
rather than a demo.

| | |
| --- | --- |
| `formsServerUrl` | **read only.** Questionnaire search and resolve-by-canonical. Never written to |
| `terminologyServerUrl` | ValueSet expansion, passed straight through to the renderer |
| `responseServerUrl` | the **EHR**: patients and responses read from it, reviewed responses written to it. **Required to save, and to use `/responses` or `/patients`** |
| `blobServerUrl` | where SHL payloads and reply slots are hosted as `Binary`. **Required to create Health Links** |
| `blobStore` | how payloads are stored. `fhir-binary` is the only implementation |
| `linkBaseUrl: null` | use `window.location.origin`. Set it when the device opening the link cannot resolve that origin — a phone scanning a laptop's QR, or a reverse proxy on a different host |
| `linkCodec` | which codec *creates* links; reading always accepts both. `shl` is the only one that mints — `"bespoke"` still validates, so an old config is not rejected wholesale, but it fails at mint time |
| `shlManifestUrl` | base URL of an external manifest server, if one is ever stood up. Unused while `blobStore` is `fhir-binary` — *reading* manifest links needs no config |
| `senderName` | `Task.requester.display`. An invitation that cannot say who sent it is one a patient has reason to decline |
| `enableServerReturn` | offer channel B. **Off by default** — it accepts answers without review |
| `enableEncryptedReply` | offer channel C, the encrypted reply slot. **Off by default** — answers come back as a link the filler mints. Turn it on when a filler may have no way to show you a QR code. Requires `blobServerUrl` |
| `linkLifetimeDays` | sets the link's `exp` and the reply slot's `expiresAt`. `null` for no expiry |
| `publishRequestTasks` | record sent requests on the EHR so `/requests` can list them from any browser. Publishes what was requested, for whom and by whom — turn it off if that should not be on a shared server |

Fields added after the first release are optional in `config.json`: a config written before they existed
takes their defaults rather than being rejected wholesale, which would discard the servers it *does*
name and quietly point a deployment somewhere else.

### Pointing it at your own servers

Minimum viable change for a real deployment — the forms and terminology servers can stay as they are:

```json
{
  "formsServerUrl": "https://smartforms.csiro.au/api/fhir",
  "terminologyServerUrl": "https://r4.ontoserver.csiro.au/fhir",
  "linkBaseUrl": "https://links.example.org",
  "linkCodec": "shl",
  "responseServerUrl": "https://fhir.example.org/r4",
  "blobServerUrl": "https://fhir.example.org/r4",
  "blobStore": "fhir-binary",
  "shlManifestUrl": null,
  "senderName": "Parkview Medical Centre"
}
```

`responseServerUrl` needs `Patient` and `QuestionnaireResponse` read plus `QuestionnaireResponse`,
`Task` and `Provenance` create. `blobServerUrl` needs only `Binary` create and read, and **need not
be a server you control** — the payload is a JWE and the key travels only inside the link.

### What happens when config is missing

A missing or malformed `config.json` is not fatal: the app falls back to the public CSIRO **forms and
terminology** servers, with **both write targets `null`**. In that state it reads and renders forms
but refuses to mint links or save responses, and says so on the surfaces that would need them.

That asymmetry is deliberate. Guessing a write target because config failed to load is worse than
refusing — it would put patient data on whatever server happened to be named for reading. A check
asserts the fallback names no write target, and another asserts the *shipped* config does.

### Read and write are separate servers, with no fallback

`formsServerUrl` is a **catalogue**. smart-forms only ever issues `GET Questionnaire` and `$assemble`
against it and writes responses to its SMART launch server instead — see `saveQr.ts:133`, which posts
to `smartClient.state.serverUrl`.

This app has no launch context and therefore no such server, so the write targets **deliberately do
not fall back to `formsServerUrl`**. Setting them to the forms server is asserted against, because
quietly putting patient data and encrypted blobs into a shared reference library is the specific
mistake worth preventing rather than documenting.

## Deploying

```bash
npm run build        # tsc -b && vite build  ->  dist/
npm run preview      # serve dist/ locally to check it
```

`dist/` is a static site. Two requirements:

**1. SPA rewrite.** Every path must serve `index.html`, or `/view`, `/scan` and the rest 404 on
refresh or on a scanned link. The fragment cannot be used for routing here — it is carrying the
payload — so hash routing is not an option.

<table>
<tr><td>Netlify</td><td><code>_redirects</code>: <code>/* /index.html 200</code></td></tr>
<tr><td>Vercel</td><td><code>vercel.json</code>: <code>{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}</code></td></tr>
<tr><td>nginx</td><td><code>try_files $uri $uri/ /index.html;</code></td></tr>
<tr><td>Apache</td><td><code>FallbackResource /index.html</code></td></tr>
<tr><td>S3 + CloudFront</td><td>error document <code>index.html</code>, or a 403/404 → <code>/index.html</code> response mapping</td></tr>
<tr><td>GitHub Pages</td><td>copy <code>index.html</code> to <code>404.html</code>; also needs <code>vite build --base=/repo-name/</code> if not served from the domain root</td></tr>
</table>

**2. HTTPS.** The camera on `/scan` needs a secure context, and so does the Web Crypto used for
every link. Neither works over plain HTTP off `localhost`.

Then edit `dist/config.json` for the environment — no rebuild needed, which is the whole reason
config is fetched at runtime. Serve it with a short cache lifetime, or a stale copy will outlive a
server change.

### Container and Kubernetes

`Dockerfile` builds the site and serves it from nginx with both requirements
already met: unknown paths fall through to `index.html`, and `config.json` is
served `no-store` while the hashed assets beside it are immutable for a year.
The container listens on 8080, runs as an unprivileged user, and answers
`/healthz` independently of the app bundle so a probe does not depend on the
shell being readable.

```bash
docker build -t smart-forms-health-links:local .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp smart-forms-health-links:local
```

The Helm chart under `deploy/helm/smart-forms-health-links` runs that image and
supplies `config.json` from a ConfigMap, so one image serves any environment.
Its own README documents the values. The chart holds no ingress: how the app is
exposed differs per cluster, so the ingress is applied beside the release.

```bash
helm upgrade --install smart-forms-health-links deploy/helm/smart-forms-health-links \
  --namespace formlinks \
  --values deploy/demo/values.yaml \
  --set smartFormsHealthLinks.image=my-registry/smart-forms-health-links:abc1234
```

`deploy/demo` is the deployment at
[formlinks.fhirapp.net](https://formlinks.fhirapp.net): its values and its ALB
ingress. Pushing to `main` runs `.github/workflows/deploy.yml`, which builds a
multi-architecture image tagged with the commit, pushes it to ECR and rolls the
release onto it. The workflow authenticates by assuming an IAM role through
GitHub's OIDC provider, so there are no stored credentials.

## Repo layout

```
src/
  App.tsx              routes, and the root-fragment → /view forward
  routes/              one file per route: FormList, RequestForm, Requests,
                       ResponseList, PatientList, FillForm, ViewLink, Scan
  components/
    FormRenderer.tsx   the smart-forms-renderer composition
    FillFromRequest.tsx  the filler's side: render, then return answers
    ReviewResponse.tsx   the requester's side: read-only review, then write
    PatientPicker.tsx  inline patient search, at both ends of the round trip
    RawAnswers.tsx     the fallback table when a Questionnaire cannot be resolved
    ShareLinkPanel.tsx QR + copyable link
  link/
    codec.ts           the LinkCodec interface and codec selection
    shlCodec.ts        shlink:/  — the only codec that mints
    bespokeCodec.ts    sfhl:/    — decode-only, legacy
    createLink.ts      builds the request Bundle and the invitation
    exchange.ts        resolves a link into something renderable
    jwe.ts             alg:dir + A256GCM
    replyCrypto.ts     ECDH-ES + A256GCM, P-256 — channel C
    replySlot.ts       minting and reading the reply slot
    replyDescriptor.ts the wire format for channels B and C
    collectReply.ts    pulling and decrypting a reply
    qr.ts qrCapacity.ts binary.ts registry.ts
  fhir/
    formsServer.ts     Questionnaire search and resolve-by-canonical
    ehrServer.ts       patients, responses, published request Tasks
    blobStore.ts       Binary create/read, and the Location-header workaround
    submit.ts          the write: endpoint resolution, meta handling, Provenance
  lib/
    config.ts          AppConfig, validation, and the fallback
    requestStore.ts    reply keys in localStorage
    sentRequests.ts    the local half of /requests
    answerRows.ts      flattening a QuestionnaireResponse for RawAnswers
scripts/
  roundtrip.ts         npm run check:roundtrip — no network
  e2eShl.ts            npm run check:e2e-shl   — live, writes and cleans up
  e2eLink.ts           npm run check:e2e       — the legacy decode path
docs/
  shl-form-reply-channel.md   wire format for channels B and C
  response-links.md           what counts as an inbound response link
  u-flag-hosting.md           the third-party blocker, in full
deploy/
  nginx.conf                  SPA rewrite, and the cache policy that goes with it
  helm/smart-forms-health-links/  the chart, and its own README
  demo/                       values and ingress for formlinks.fhirapp.net
public/config.json     runtime config
```

## Known limitations

### ⚠️ The links we mint cannot be opened by other SHL apps

"Only a file host" is true but underspecifies it: a FHIR `Binary` looks like a file host and is not
one for this purpose. The spec makes a `recipient` query parameter **required** on the `U`-flag
`GET`, and the HAPI server we park payloads on answers an unrecognised parameter with a `400`:

```
GET .../Binary/137286897                          -> 200 application/jose
GET .../Binary/137286897?recipient=Platypus…      -> 400 not-supported
```

So every link this app mints fails in any conformant wallet. Our own viewer works only because it
omits the parameter, which is the same defect facing the other way.

**This is unfixed, and it blocks every third-party demo.** The cause, the full list of what has to
change, and when to come back to it are in [`docs/u-flag-hosting.md`](docs/u-flag-hosting.md).

Note the gap is one-directional. It blocks the *outbound* leg only: whatever anyone else does about
`?recipient=`, this app already reads links Platypus mints, including manifest-hosted ones and
payloads that are a bare resource rather than a Bundle. **The return leg is not waiting on anybody.**

### Other limitations, by design or otherwise

- **Links this app mints carry no passcode and cannot be revoked.** `U` cannot be combined with `P`,
  and a hosted `Binary` has no per-recipient variation. Reading a passcode-protected manifest link
  works fine; minting one does not.
- **No SMART App Launch.** There is no launch context, no OAuth, and therefore no user identity —
  which is why the write target has to be configured rather than discovered. `proxy.smartforms.io/v/r4/fhir`
  is the base to start from if this ever needs it.
- **Reply keys live in `localStorage`** (channel C only). Clearing site data destroys pending
  replies, permanently. See [Notes](#notes).
- **A reply slot hosted as a plain `Binary` can be overwritten by anyone who can reach the server.**
  They cannot read it. `replyToken` is reserved in the descriptor for hosts that can gate writes.
- **The default servers are shared public sandboxes** and are wiped periodically.
- **No automated browser tests.** The checks cover the codecs, crypto, wire formats and the live
  FHIR round trip; the UI is verified by hand.

## Checks

```bash
npm run typecheck        # tsc project references
npm run build            # tsc + vite build
npm run check:roundtrip  # 195 checks: codecs, JWE, reply crypto, foreign links, passcodes — no network
npm run check:e2e        # the retained bespoke decode path, against the live forms server

# 72 checks: both round trips, request tracking, foreign response links, the deferred channel.
# Reads the forms server, writes only to SHL_WRITE_SERVER
SHL_WRITE_SERVER=https://proxy.smartforms.io/fhir npm run check:e2e-shl
```

`check:roundtrip` needs neither network nor hosting, so it is the one to run on every change. It
covers the crypto properties that matter — a wrong key, a tampered ciphertext and a tampered `epk`
must all fail, and an `alg: dir` header must be refused where `ECDH-ES` is required — plus the SHL
codec against an in-memory blob store. Four sections are worth knowing about:

- **Cross-implementation crypto vectors.** The reply crypto is checked against an independent
  `node:crypto` implementation *in both directions*, transcribed from Platypus's own
  `scripts/shl-invite.mjs`. A self-consistent implementation of the wrong Concat-KDF passes its own
  round trip perfectly and cannot talk to anyone; only a second implementation catches that.
- **The Platypus detection contract.** `questionnaireRefFromTask` and `taskTargetsQuestionnaire` are
  ported verbatim and run against a freshly built request, so a change to how the Task names its
  Questionnaire cannot silently stop a third party recognising our invitations. The negative case is
  asserted too — the `focus.type`-without-canonical half-change must *not* be detectable — because the
  positive checks alone would prove nothing.
- **Attribution on write.** That `meta.security` survives, that `versionId`/`lastUpdated`/`id` do not,
  and that a `Provenance` is retargeted to the real response id.
- **The published request Task and the sent-request join.** That `focus` is dropped and the canonical
  kept in `input`, that no reply slot or key reaches the server copy, and that a listed Task pairs with a
  local record on `identifier` alone.

`check:e2e-shl` walks both return paths live: build a request with a reply slot, encrypt it, host it as a
`Binary`, decode it as the filler would, answer it, return the answers **as a link** and **through the
encrypted slot**, then collect, decrypt, review and submit. It asserts that the hosted blob leaks no
plaintext, that the blob is **not** on the forms server, that the reply slot and public key appear
nowhere in the `shlink:` string, that the slot holds ciphertext only, that a stranger's key cannot
decrypt it, that `PATAST` and the `Provenance` survive all the way into storage, and that the stored
Task points at the response's *real* id rather than a `urn:uuid`. It also asserts the
unresolvable-subject failure mode above.

It also publishes a request `Task` and searches it back out by tag, because that is a **server-side**
constraint a unit check cannot prove — a canonical in `Task.focus` is rejected outright, and nothing
short of a real server says so.

It skips without `SHL_WRITE_SERVER` rather than defaulting to one, because it writes; and it refuses to
run if that is set to the forms server. Everything it creates — four `Binary`s, a `Patient`, three
`QuestionnaireResponse`s, three `Task`s and a `Provenance` — is deleted afterwards in reverse
dependency order, and a failed delete is reported rather than swallowed. That matters more now the
default write target is a shared CSIRO sandbox rather than a throwaway one.

### `check:roundtrip` needs a sibling smart-forms checkout

It imports three real QuestionnaireResponse fixtures by relative path, so it will not run without
one:

```bash
git clone https://github.com/aehrc/smart-forms.git ../smart-forms   # no install needed
```

The imports are static and resolved by esbuild at bundle time, so a missing checkout is a build error
rather than a skipped section — the script does not currently degrade. Nothing else in the repo has
any coupling to the monorepo: the app itself depends only on `@aehrc/smart-forms-renderer` from npm,
and `npm run dev`, `npm run build` and `check:e2e-shl` all work without it.

Not covered by any of these:

- **A third-party wallet opening a link this app mints**, blocked on the `?recipient=` defect above.
- **Manifest mode and the passcode path, live.** A FHIR `Binary` cannot answer a manifest `POST` and
  there is no manifest server to point `check:e2e-shl` at, so both are covered offline instead —
  against a shimmed manifest in `check:roundtrip`, including the assertion that a `P`-flagged link
  costs no attempt before prompting.
- **The UI itself.** No browser automation.

Everything else is verified end to end. The inbound direction is additionally exercised against
foreign-shaped payloads this app would never itself produce.

## Notes

- **Reply keys live in `localStorage`, and clearing site data destroys pending replies.** Applies only
  when `enableEncryptedReply` is on; by default no key is generated because no slot is minted. The private
  key for a request exists nowhere else — not in the link, not on the blob server, not with the filler
  — so a reply that arrives after it is gone is unreadable by anyone, permanently. `/requests` exports
  to JSON to move requests between browsers; **that file decrypts every reply it covers**, which the UI
  says at the point of export. A deployment handling requests it cannot afford to lose should hold the
  keys somewhere designed for keys.
- **Referential integrity will reject foreign subjects — and for answers from another app this is the
  normal case, not an edge case.** A third-party filler names the patient in *its* terms (Platypus sends its
  own local vault key), so a response naming a patient the destination does not hold fails with
  `HAPI-1094: Resource Patient/x not found, specified in path: QuestionnaireResponse.subject`.
  `ReviewResponse` probes the subject against the destination *before* enabling Accept and offers
  reconciliation — including a search of that destination, since a reference is only worth anything on
  the server it will be stored on, and a questionnaire declaring its own `sdc-questionnaire-endpoint`
  makes that a different server from the configured one. The subject is still never silently stripped
  to force the write through — that would lose who the answers are about, and clearing it is an
  explicit, labelled choice. Picking a patient replaces the foreign `display` rather than merging it,
  because a name the filler's system chose does not describe the record the reviewer just pointed at.
- **Answers naming *no* patient are the quieter half of the same problem.** An unresolvable subject at
  least fails loudly. A response with no `subject` is accepted by every server and files the answers
  against nobody, permanently, so it is asked about just as loudly as a subject that does not resolve.
- **Nothing is written without review — on channels A and C.** `ReviewResponse` renders read-only on
  purpose: editing another party's answers before committing them would blur who recorded what and make
  the response's `author`/`source` describe a document that no longer exists. Channel B is the
  exception, by construction: it hands a filler an endpoint and the answers land unreviewed. That is
  why it is off by default.
- **A foreign `id` is stripped before writing, but not the whole of `meta`.** A response from another
  app carries identity from *its* server, so `id`, `meta.versionId`, `meta.lastUpdated` and
  `meta.source` go. `meta.security`, `meta.tag` and `meta.profile` **stay**. Dropping `meta` wholesale
  is the obvious reading of "strip foreign identity" and it silently discards the `PATAST`
  patient-asserted label, filing answers a patient typed on their phone as though a clinician had
  recorded them. Any accompanying `Provenance` is written too, retargeted from its `urn:uuid` to the
  created response.
- **A reply slot's placeholder is unique per slot.** A fixed sentinel makes every slot after the first a
  byte-identical create, which servers that deduplicate refuse outright
  (`HAPI-2840: Can not create resource duplicating existing resource`) — so the second request ever
  minted would fail to get a slot.
- **`Location` headers from the forms server are wrong** — it reports
  `http://smartforms.csiro.au/fhir/Binary/{id}`: wrong scheme *and* wrong path. `blobStore.ts` takes
  only the id and rebuilds the URL against the configured base.
- **Camera:** scanning needs a secure context. `localhost` qualifies; opening the dev server by LAN
  IP from a phone does not — use HTTPS or a tunnel. There is a paste fallback on `/scan`.
- **Two style systems:** the shell is Tailwind, the form is MUI. MUI is a hard dependency of the
  renderer, so it ships either way; `apps/demo-renderer-app` upstream makes the same trade.
- **Renderer API:** `SmartFormsRenderer` is deprecated upstream. This app uses the supported
  `useBuildForm` + `RendererThemeProvider` + `BaseRenderer` composition. Note that `useBuildForm`
  takes a params object — the positional signature in upstream's `demo-renderer-app` is stale.

## Provenance

A demonstrator from [AEHRC](https://aehrc.csiro.au/), CSIRO's Australian e-Health Research Centre,
built on the same renderer as [smart-forms](https://github.com/aehrc/smart-forms) and designed to
interoperate with [Platypus](https://github.com/aehrc/platypus). It depends on
`@aehrc/smart-forms-renderer` from npm only, so it tracks published releases rather than the
monorepo's `main`.

It is a demonstrator: it exists to show that the round trip works and to pin down the wire formats in
[`docs/`](docs) precisely enough for someone else to implement against. It is not a supported product,
and the default servers are public sandboxes.

## Licence

Apache License 2.0 — see [`LICENSE`](LICENSE). The same licence as
[smart-forms](https://github.com/aehrc/smart-forms).

Copyright 2026 Commonwealth Scientific and Industrial Research Organisation (CSIRO).
