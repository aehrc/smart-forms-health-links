# Smart Forms Health Links

Browse the questionnaires on a Smart Forms server, fill one in, and turn the result into a
scannable link that another device can open and keep filling.

Built on [`@aehrc/smart-forms-renderer`](https://www.npmjs.com/package/@aehrc/smart-forms-renderer)
from npm — this project has no build-time coupling to the
[smart-forms](https://github.com/aehrc/smart-forms) monorepo.

```bash
npm install
npm run dev          # http://localhost:5273
```

## What it does

| Route            | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `/`              | Search and list Questionnaires on the forms server                   |
| `/fill/:id`      | Render a form, then generate a link + QR from the current answers    |
| `/view#<link>`   | Decode a link, resolve its Questionnaire, render with answers restored |
| `/scan`          | Read a QR with the camera, or paste a link                           |

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

### ⚠️ Phase 1 links are not encrypted

Answers are compressed, not protected. Anyone who photographs the QR code or reads the URL can
recover them. This is fine for demos and for scanning between your own devices. It is **not**
suitable for real patient data — that is what Phase 2 is for.

## Phase 2: SMART Health Links

Third-party SHL wallets cannot read Phase 1 links, and no backend-free design can make them:
[SMART Health Links](https://docs.smarthealthit.org/smart-health-links/) has no embedded-payload
mode — the QR holds a pointer to a manifest server, and the content is encrypted.

The app is built so this is a **transport swap, not a rewrite**. `LinkContent` (`src/link/codec.ts`)
is already a FHIR Bundle, which is exactly what an SHL manifest file contains, so the routes, the
renderer, and response extraction are all unchanged by the cutover.

To ship Phase 2:

1. Implement `encode`/`decode` in `src/link/shlCodec.ts` (AES-256-GCM via WebCrypto + JWE compact).
2. Stand up a manifest server.
3. Set `shlManifestUrl` and flip `linkCodec` to `"shl"` in `public/config.json`.

Links created before the cutover keep working: `decodingCodec()` sniffs the prefix across every
registered codec, so `sfhl:/` and `shlink:/` are both readable regardless of which one is being
issued.

## Configuration

Runtime config is fetched from `/config.json` at boot — the same pattern as
`apps/smart-forms-app` in the smart-forms monorepo — so one build can be deployed against
different servers. Missing or malformed config falls back to the public CSIRO servers.

```json
{
  "formsServerUrl": "https://smartforms.csiro.au/api/fhir",
  "terminologyServerUrl": "https://r4.ontoserver.csiro.au/fhir",
  "linkBaseUrl": null,
  "linkCodec": "bespoke",
  "shlManifestUrl": null
}
```

`linkBaseUrl: null` means "use `window.location.origin`".

## Notes

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
npm run check:roundtrip  # codec round-trip against real smart-forms fixtures
npm run check:e2e        # search -> encode -> decode -> resolve, against the live forms server
```

`check:e2e` walks the whole path a scanned link depends on, short of rendering: search the forms
server, build a response, encode a link, decode it, and resolve the Questionnaire back from its
canonical (including the version-pinned form, `…|0.1.0`).

`check:roundtrip` imports fixtures from a sibling `../smart-forms` checkout. It is the only
coupling between the repos, and it is dev-only.
