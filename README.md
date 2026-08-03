# Smart Forms Health Links

Ask someone to fill out a FHIR questionnaire by handing them a scannable
[SMART Health Link](https://docs.smarthealthit.org/smart-health-links/), let them complete it on
another device with no access to your servers, then review the answers and write them to your own
FHIR server.

Built on [`@aehrc/smart-forms-renderer`](https://www.npmjs.com/package/@aehrc/smart-forms-renderer)
from npm — this project has no build-time coupling to the
[smart-forms](https://github.com/aehrc/smart-forms) monorepo.

```bash
npm install
npm run dev          # http://localhost:5273
```

## What it does

| Route              | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `/`                | Search and list Questionnaires on the forms server                          |
| `/request/:id`     | Create an encrypted SMART Health Link containing a whole form               |
| `/fill/:id`        | Fill a form directly and emit a link from the answers                       |
| `/view#<link>`     | Open any link — **dispatches on payload**: fill a request, or review a response |
| `/scan`            | Read a QR with the camera, or paste a link                                   |

`/view` deliberately decides what to show from the payload rather than the route, because a scanner
cannot know whether it just scanned a request or a completed response.

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

RETURN    offline QR by default, or a hosted Health Link
  7. requester opens it — reading needs no infrastructure, so either works
  8. HUMAN REVIEWS the answers, read-only
  9. on accept: POST /QuestionnaireResponse + POST /Task
```

Measured on the live server for the GP Chronic Condition Management Plan:

| | bytes |
| --- | --- |
| Questionnaire | 111,319 |
| Encrypted blob (hosted) | 149,521 |
| **The link itself** | **271** |
| Return payload (no Questionnaire) | 1,119 |

## Why it is shaped this way

**SMART Health Links are strictly one-directional.** Neither the
[SHL spec](https://docs.smarthealthit.org/smart-health-links/spec/) nor the
[HL7 links-specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html)
defines any submission, upload or writeback channel, and neither mentions questionnaires or requests
for data at all. Using an SHL as a *return* transport is off-spec.

Nothing off-spec is needed, because **the requester's own app performs the write**. A filler
publishes; this app pulls, shows a human, and only then writes to its own server. So no credential
ever has to travel to the filler, `application/smart-api-access` is unnecessary, and
review-before-commit — the right posture for third-party data entering a clinical record — falls out
for free.

The write itself is not novel: `POST /QuestionnaireResponse` is core FHIR REST and exactly SDC's Form
Receiver model. SDC even specifies the destination, via
`http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint` — which this app honours
(including its "send to all listed endpoints" rule) and which smart-forms lists as unsupported.

**Correlation runs from the Task outward**, because R4 gives QuestionnaireResponse no way to point at
a Task: `basedOn` accepts only `CarePlan|ServiceRequest`, `partOf` only `Observation|Procedure`, and
`identifier` is `0..1`. So `Task.focus` names the Questionnaire, `Task.output.valueReference` names
the response, and the Task round-trips inside the Bundle. Its `identifier` is the durable key — the
`urn:uuid` references do not survive the trip, but that does.

**Hosting the encrypted blob on a public server is the design, not a shortcut.** SHL assumes an
untrusted host: the file is a JWE and the key travels only in the link, so the host never sees
plaintext. That is why a FHIR `Binary` on the open forms server is a legitimate file host and no
S3/lambda tier is required.

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
   hosting therefore needs an SPA rewrite (all paths → `index.html`), or `/view` will 404.

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

The SHL codec always sets the **`U` flag** — a single encrypted file fetched with a plain `GET` — so
it needs only a file host rather than a manifest service. Two honest costs: `U` cannot be combined
with `P`, so **these links have no passcode**, and they can be neither revoked nor varied per
recipient. It *reads* both hosting modes, so a filler that publishes behind a real manifest endpoint
works too.

### ⚠️ `sfhl:/` links are not encrypted

Answers are compressed, not protected. Anyone who photographs the QR or reads the URL recovers them.
It exists because it is the only return path open to an app with no server of its own, and it is
labelled as such in the UI.

## Configuration

Runtime config is fetched from `/config.json` at boot — the same pattern as
`apps/smart-forms-app` in the smart-forms monorepo — so one build can be deployed against
different servers. Missing or malformed config falls back to the public CSIRO servers.

```json
{
  "formsServerUrl": "https://smartforms.csiro.au/api/fhir",
  "terminologyServerUrl": "https://r4.ontoserver.csiro.au/fhir",
  "linkBaseUrl": null,
  "linkCodec": "shl",
  "responseServerUrl": null,
  "blobServerUrl": null,
  "blobStore": "fhir-binary",
  "shlManifestUrl": null
}
```

| | |
| --- | --- |
| `formsServerUrl` | **read only.** Questionnaire search and resolve-by-canonical. Never written to |
| `responseServerUrl` | where reviewed responses and Tasks are written. **Required to save** |
| `blobServerUrl` | where SHL payloads are hosted as `Binary`. **Required to create Health Links** |
| `linkBaseUrl: null` | use `window.location.origin` |
| `linkCodec` | which codec *creates* links; reading always accepts both |

### Read and write are separate servers, with no fallback

`formsServerUrl` is a **catalogue**. smart-forms only ever issues `GET Questionnaire` and `$assemble`
against it and writes responses to its SMART launch server instead — see `saveQr.ts:133`, which posts
to `smartClient.state.serverUrl`.

This app has no launch context and therefore no such server, so the write targets are `null` by
default and **deliberately do not fall back to `formsServerUrl`**. With them unset, the app explains
what to configure instead of quietly putting patient data and encrypted blobs into a shared reference
library. Both surfaces disable their action and say so.

`blobServerUrl` need not be a trusted server — the payload is a JWE and the key travels only inside
the link. Any FHIR server accepting `Binary` create/read will do.

## Notes

- **Referential integrity will reject foreign subjects.** The forms server enforces it, so a response
  naming a patient it does not hold fails with
  `HAPI-1094: Resource Patient/x not found, specified in path: QuestionnaireResponse.subject`. This is
  surfaced verbatim rather than swallowed, and the subject is deliberately **not** stripped to force
  the write through — that would lose who the answers are about. Reconciling the patient is a
  human decision.
- **Nothing is written without review.** `ReviewResponse` renders read-only on purpose: editing another
  party's answers before committing them would blur who recorded what and make the response's
  `author`/`source` describe a document that no longer exists.
- **A foreign `id`/`meta` is stripped before writing.** A response from another app carries identity
  from *its* server; keeping it risks colliding with an unrelated local resource.
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

## Checks

```bash
npm run typecheck        # tsc project references
npm run build            # tsc + vite build
npm run check:roundtrip  # 42 checks: codecs, JWE, SHL — no network, no hosting
npm run check:e2e        # bespoke path against the live forms server

# 30 checks: the full SHL round trip, live. Reads the forms server, writes only to SHL_WRITE_SERVER
SHL_WRITE_SERVER=https://hapi.fhir.org/baseR4 npm run check:e2e-shl
```

`check:roundtrip` covers the crypto properties that matter — a wrong key and a tampered ciphertext
must both fail — plus the SHL codec against an in-memory blob store, so it needs neither network nor
hosting.

`check:e2e-shl` walks the entire loop live: build a request, encrypt it, host it as a `Binary`, decode
it as the filler would, answer it, and submit the result. It asserts that the hosted blob leaks no
plaintext, that the blob is **not** on the forms server, and that the stored Task points at the
response's *real* id rather than a `urn:uuid`. It also asserts the unresolvable-subject failure mode
below.

It skips without `SHL_WRITE_SERVER`, and refuses to run if that is set to the forms server. Everything
it creates — `Binary`, `Patient`, `QuestionnaireResponse`, `Task` — is deleted afterwards in reverse
dependency order, and a failed delete is reported rather than swallowed.

`check:roundtrip` imports fixtures from a sibling `../smart-forms` checkout. It is the only
coupling between the repos, and it is dev-only.
