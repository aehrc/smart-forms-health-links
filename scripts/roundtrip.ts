/**
 * Offline checks for the link layer, run against the real QuestionnaireResponse fixtures
 * from the smart-forms repo. Bundled with esbuild and run in Node, which supports the same
 * CompressionStream/btoa APIs the browser codec uses.
 *
 *   npm run check:roundtrip
 *
 * The fixture imports below reach into a sibling checkout of aehrc/smart-forms. That is the only
 * coupling between the two repos and it is dev-only — if the checkout is missing or moved, this
 * script fails to bundle but the app itself is unaffected.
 */
import { readFileSync } from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  randomBytes
} from 'node:crypto';
import type { Provenance, Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import {
  DEFAULT_SMART_SCOPES,
  FALLBACK_CONFIG,
  canUseEncryptedReply,
  canUseSmartLaunch,
  isAppConfig,
  type AppConfig
} from '../src/lib/config';
import { isLaunchedServer } from '../src/fhir/authedFetch';
import {
  buildScopes,
  isPrePopulateScope,
  isWriteBackScope,
  mergePermissions,
  missingScopes,
  registrationScopes
} from '../src/auth/scopes';
import { populatedRows, pruneAnswers } from '../src/lib/answerRows';
import { questionnaireDeclaresPopulation } from '../src/fhir/populate';
import { bespokeCodec } from '../src/link/bespokeCodec';
import { shlCodec } from '../src/link/shlCodec';
import {
  PasscodeRequiredError,
  bundleResponse,
  encodingCodec,
  extractFragment,
  responseFromBundle
} from '../src/link/codec';
import { chooseErrorCorrectionLevel } from '../src/link/qrCapacity';
import { decodeUtf8, encodeUtf8, fromBase64Url, toBase64Url } from '../src/link/binary';
import { decryptJwe, encryptJwe, generateKey, keyToBase64Url } from '../src/link/jwe';
import {
  decryptReplyJwe,
  encryptReplyJwe,
  generateReplyKeyPair,
  looksLikeReplyJwe
} from '../src/link/replyCrypto';
import { replySlotPlaceholder } from '../src/link/replySlot';
import {
  REPLY_DESCRIPTOR_EXTENSION,
  WRITE_DESCRIPTOR_EXTENSION,
  buildReplyDescriptorExtension,
  buildServerTaskUrlExtension,
  buildWriteDescriptorExtension,
  isReplyDescriptorExpired,
  isSafeWriteUrl,
  isWriteDescriptorExpired,
  parseReplyDescriptor,
  parseReturnChannels,
  parseServerTaskUrl,
  parseWriteDescriptor,
  writeSlotId
} from '../src/link/replyDescriptor';
import {
  buildReplyBundle,
  buildRequestBundle,
  buildResponseBundle,
  buildWriteResponse,
  isRequestBundle,
  parseRequestBundle,
  parseResponseBundle,
  responseCanonical,
  taskCorrelationId
} from '../src/link/exchange';
import { flattenAnswers } from '../src/lib/answerRows';
import {
  SHL_REQUEST_TAG,
  asPublishedTask,
  declareResponseEndpoint,
  declaredEndpoints,
  referenceResolves,
  resolveDestinations,
  submitResponse
} from '../src/fhir/submit';
import { findRequestForTask, mergeSentRequests, whyNotCollectable } from '../src/lib/sentRequests';
import type { OutstandingRequest } from '../src/lib/requestStore';
import { JOSE_CONTENT_TYPE, inMemoryBlobStore } from '../src/fhir/blobStore';
/*
 * From `templateExtract`, not `extract`: its sibling imports the renderer, which is a browser bundle
 * with CSS and fonts in it and does not bundle for Node. Same split, and same reason, as `scopes.ts`
 * above. Observation-based extraction is therefore checked by the renderer's own suite, not here.
 */
import { canTemplateExtract, retargetSubject, templateExtract } from '../src/fhir/templateExtract';
import { describeEntries, describeResource, filterBundle } from '../src/lib/extractedEntries';

import { QRSepsisRisk } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRSepsisRisk';
import { QRRegularMedications } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRRegularMedications';
import { QRMedicalHistoryCurrentProblems } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRMedicalHistoryCurrentProblems';
import { QSepsisRisk } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaires/QSepsisRisk';
import { QMedicalHistoryCurrentProblemsWithPatch } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaires/QMedicalHistoryCurrentProblemsWithPatch';

const BASE_URL = 'https://links.example.org';

const FIXTURES = [
  { name: 'QRSepsisRisk', response: QRSepsisRisk },
  { name: 'QRRegularMedications', response: QRRegularMedications },
  { name: 'QRMedicalHistoryCurrentProblems', response: QRMedicalHistoryCurrentProblems }
];

let failures = 0;
let total = 0;

/**
 * Report every assertion, pass or fail. A silently-skipped check is indistinguishable from a
 * passing one, so the count is part of the result.
 */
function check(name: string, condition: boolean, detail = '') {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('link codec round-trip\n');
console.log('fixture                            raw   link   QR level  round-trip');

for (const { name, response } of FIXTURES) {
  // A link is only openable if the response names its Questionnaire.
  const withCanonical = response.questionnaire
    ? response
    : { ...response, questionnaire: 'http://example.org/Questionnaire/test' };

  const link = await bespokeCodec.encode(
    { bundle: bundleResponse(withCanonical), label: name },
    { baseUrl: BASE_URL }
  );

  const decoded = await bespokeCodec.decode(link);
  const decodedResponse = responseFromBundle(decoded.bundle);

  const rawBytes = Buffer.byteLength(JSON.stringify(withCanonical));
  const linkBytes = Buffer.byteLength(link);
  const level = chooseErrorCorrectionLevel(link);

  const identical =
    JSON.stringify(decodedResponse) === JSON.stringify(withCanonical) && decoded.label === name;

  console.log(
    `${name.padEnd(34)}${String(rawBytes).padStart(5)}${String(linkBytes).padStart(7)}` +
      `${(level ?? 'TOO BIG').padStart(10)}  ${identical ? 'ok' : 'MISMATCH'}`
  );

  check(name, identical);
  check(name, link.startsWith(`${BASE_URL}/view#sfhl:/`));
  check(name, level !== null);
}

// Codec discrimination: the bespoke codec must not claim SHL links, and vice versa.
check(
  'canDecode/shlink',
  !bespokeCodec.canDecode('https://viewer.example.org#shlink:/eyJ1cmwiOiJ4In0')
);
check('canDecode/garbage', !bespokeCodec.canDecode('https://example.org/nothing'));
check('canDecode/bare', bespokeCodec.canDecode('sfhl:/abc'));

// Fragment extraction across the shapes a scanner can hand back.
check('extract/url', extractFragment('https://a.org/view#sfhl:/xyz') === 'sfhl:/xyz', '');
check('extract/hash', extractFragment('#sfhl:/xyz') === 'sfhl:/xyz', '');
check('extract/bare', extractFragment('sfhl:/xyz') === 'sfhl:/xyz', '');
check('extract/plainUrl', extractFragment('https://a.org/view') === '', '');

// Corrupt payloads must fail loudly rather than render a half-decoded form.
for (const [label, bad] of [
  ['truncated', 'sfhl:/AAAA'],
  ['empty', 'sfhl:/'],
  ['not-base64', 'sfhl:/!!!!']
] as const) {
  let threw = false;
  try {
    await bespokeCodec.decode(bad);
  } catch {
    threw = true;
  }
  check(`decode/${label}`, threw);
}

// ---------------------------------------------------------------------------
// The shipped config must validate. A typo would otherwise only surface at runtime, as a silent
// fall back to FALLBACK_CONFIG behind a console warning.
// ---------------------------------------------------------------------------

console.log('\nconfig\n');

// Resolved from cwd, not import.meta.url: this script is bundled into node_modules/.cache first, so
// a module-relative path would look there. npm scripts run from the package root.
const shippedConfig: unknown = JSON.parse(
  readFileSync(`${process.cwd()}/public/config.json`, 'utf8')
);

check('config/isValid', isAppConfig(shippedConfig), JSON.stringify(shippedConfig));

if (isAppConfig(shippedConfig)) {
  // The forms server is a read-only catalogue; writing there is the bug this guards against.
  check(
    'config/writeTargetsAreNotTheFormsServer',
    shippedConfig.responseServerUrl !== shippedConfig.formsServerUrl &&
      shippedConfig.blobServerUrl !== shippedConfig.formsServerUrl,
    `responses -> ${shippedConfig.responseServerUrl}, blobs -> ${shippedConfig.blobServerUrl}`
  );

  // The shipped config is the demo: `npm install && npm run dev` has to complete the whole round trip
  // with nothing else configured. Both write targets are required for that — without a blob host no
  // link can be minted at all, and without an EHR reviewed answers have nowhere to land. This is the
  // opposite requirement to FALLBACK_CONFIG below, and deliberately so: what ships in the repo is a
  // chosen sandbox, whereas the fallback is a config that failed to load and must guess nothing.
  check(
    'config/shippedConfigCompletesTheLoop',
    typeof shippedConfig.responseServerUrl === 'string' &&
      typeof shippedConfig.blobServerUrl === 'string',
    'a clone with no setup must be able to mint a link and save a reviewed response'
  );

  /*
   * The shipped demo offers channel D and a SMART launch. Asserted for the same reason the write
   * targets are: they are features of the demo, and an edit that quietly switches one off should fail
   * a check here rather than a demonstration later.
   *
   * Note this is the *shipped* config, not FALLBACK_CONFIG — which must stay off, and is checked
   * separately below. The two pull in opposite directions on purpose.
   */
  check(
    'config/shippedConfigOffersOneShotWrite',
    shippedConfig.enableOneShotWrite === true,
    'channel D is part of the shipped demo'
  );
  check(
    'config/shippedConfigOffersWriteBack',
    shippedConfig.enableWriteBack === true,
    'writing extracted resources into the record is part of the shipped demo'
  );
  check(
    'config/shippedConfigOffersSmartLaunch',
    shippedConfig.enableSmartLaunch === true &&
      typeof shippedConfig.smartIssuerUrl === 'string' &&
      typeof shippedConfig.smartClientId === 'string',
    'a launch needs an issuer and a client id as well as the flag'
  );
}

// The fallback used when config.json is missing or malformed must NOT name a write target: silently
// writing to some server because config failed to load is worse than refusing.
check('config/fallbackHasNoWriteTargets', FALLBACK_CONFIG.responseServerUrl === null && FALLBACK_CONFIG.blobServerUrl === null);

/*
 * And it must hand out no capability either, however the shipped config is set. A config that failed
 * to load knows nothing about the deployment it landed in, so offering a filler a write slot or
 * starting an OAuth flow against a guessed issuer are both things it must not do.
 */
check(
  'config/fallbackOffersNoCapabilities',
  !FALLBACK_CONFIG.enableOneShotWrite &&
    !FALLBACK_CONFIG.enableSmartLaunch &&
    !FALLBACK_CONFIG.enableServerReturn &&
    !FALLBACK_CONFIG.enableWriteBack,
  'the shipped config enabling these must not drag the fallback along with it'
);

// ---------------------------------------------------------------------------
// JWE (alg=dir, enc=A256GCM) — the crypto layer SMART Health Links requires.
// ---------------------------------------------------------------------------

console.log('\nJWE\n');

const jweKey = generateKey();
check('jwe/keyLength', jweKey.length === 32, `${jweKey.length} bytes`);
check('jwe/keyBase64UrlIs43Chars', keyToBase64Url(jweKey).length === 43);

const jwePlaintext = encodeUtf8(JSON.stringify({ hello: 'world', nested: [1, 2, 3] }));
const compact = await encryptJwe(jwePlaintext, jweKey);
const jweSegments = compact.split('.');

check('jwe/fiveSegments', jweSegments.length === 5, `${jweSegments.length}`);
check('jwe/encryptedKeySegmentEmpty', jweSegments[1] === '');
check(
  'jwe/protectedHeader',
  decodeUtf8(fromBase64Url(jweSegments[0])) === '{"alg":"dir","enc":"A256GCM"}',
  decodeUtf8(fromBase64Url(jweSegments[0]))
);

const jweDecrypted = await decryptJwe(compact, jweKey);
check('jwe/roundTrip', decodeUtf8(jweDecrypted) === decodeUtf8(jwePlaintext));

// A wrong key must fail, not return garbage — this is the whole security property.
let wrongKeyRejected = false;
try {
  await decryptJwe(compact, generateKey());
} catch {
  wrongKeyRejected = true;
}
check('jwe/wrongKeyRejected', wrongKeyRejected);

// Tampering with the ciphertext must fail GCM authentication.
let tamperRejected = false;
try {
  const bytes = fromBase64Url(jweSegments[3]);
  bytes[0] ^= 0xff;
  await decryptJwe(
    [jweSegments[0], '', jweSegments[2], toBase64Url(bytes), jweSegments[4]].join('.'),
    jweKey
  );
} catch {
  tamperRejected = true;
}
check('jwe/tamperRejected', tamperRejected);

// ---------------------------------------------------------------------------
// SHL codec against an in-memory blob store — no network, no hosting.
// ---------------------------------------------------------------------------

console.log('\nSMART Health Links\n');

const store = inMemoryBlobStore();

// The codec fetches its payload by URL; serve the in-memory store through a fetch shim.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const stored = store.get(url);
  if (stored) {
    return new Response(stored, { status: 200 });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const shlBundle = bundleResponse({
  ...QRMedicalHistoryCurrentProblems,
  questionnaire: 'http://example.org/Questionnaire/test'
});

const shlLink = await shlCodec.encode(
  { bundle: shlBundle, label: 'Medical History' },
  { baseUrl: BASE_URL, blobStore: store }
);

check('shl/linkShape', shlLink.startsWith(`${BASE_URL}/view#shlink:/`), shlLink.slice(0, 60));
check('shl/linkIsTiny', Buffer.byteLength(shlLink) < 400, `${Buffer.byteLength(shlLink)} bytes`);
check(
  'shl/linkFitsQr',
  chooseErrorCorrectionLevel(shlLink) !== null,
  `level ${chooseErrorCorrectionLevel(shlLink)}`
);

const shlPayload = JSON.parse(
  decodeUtf8(fromBase64Url(shlLink.slice(shlLink.indexOf('shlink:/') + 'shlink:/'.length)))
);
check('shl/flagIsU', shlPayload.flag === 'U', JSON.stringify(shlPayload.flag));
check('shl/keyIs43Chars', shlPayload.key?.length === 43);
check('shl/hasUrl', typeof shlPayload.url === 'string' && shlPayload.url.length > 0);
check('shl/label', shlPayload.label === 'Medical History');

const shlDecoded = await shlCodec.decode(shlLink);
check(
  'shl/roundTrip',
  JSON.stringify(responseFromBundle(shlDecoded.bundle)) ===
    JSON.stringify(responseFromBundle(shlBundle))
);
check('shl/labelSurvives', shlDecoded.label === 'Medical History');

// The hosted blob must be opaque: no plaintext answers recoverable from it.
const hostedBlob = decodeUtf8(store.get(shlPayload.url)!);
check(
  'shl/hostedBlobIsOpaque',
  !hostedBlob.includes('QuestionnaireResponse') && hostedBlob.split('.').length === 5,
  `${hostedBlob.length} bytes of JWE`
);

// Codec discrimination in both directions.
check('shl/canDecodeShlink', shlCodec.canDecode(shlLink));
check('shl/rejectsBespoke', !shlCodec.canDecode('https://a.org/view#sfhl:/abc'));
check('bespoke/rejectsShlink', !bespokeCodec.canDecode(shlLink));

// Encoding without a blob store must fail with a useful message rather than a TypeError.
let noStoreRejected = false;
try {
  await shlCodec.encode({ bundle: shlBundle }, { baseUrl: BASE_URL });
} catch (error) {
  noStoreRejected = error instanceof Error && error.message.includes('BlobStore');
}
check('shl/requiresBlobStore', noStoreRejected);

// Expiry must be honoured.
const expiredPayload = toBase64Url(
  encodeUtf8(JSON.stringify({ url: 'https://x.test/a', key: shlPayload.key, flag: 'U', exp: 1 }))
);
let expiryRejected = false;
try {
  await shlCodec.decode(`#shlink:/${expiredPayload}`);
} catch (error) {
  expiryRejected = error instanceof Error && error.message.includes('expired');
}
check('shl/expiredRejected', expiryRejected);

// ---------------------------------------------------------------------------
// Reading a link this app did not write.
//
// The primary return path is now a filler minting its own SMART Health Link and the requester
// scanning it back, so the decode side has to cope with shapes this app would never produce: a bare
// resource where it writes a Bundle, a manifest where it writes a `U` flag, content split across
// files where it writes one. Every assertion here describes a link that is entirely legal and that
// the strict reader rejected or silently truncated.

console.log('\nforeign response links\n');

/** Host a JWE of `content` under `key` and mint the `shlink:` fragment that points at it. */
async function hostShl(content: unknown, key: Uint8Array, extra: Record<string, unknown> = {}) {
  const url = await store.put(
    encodeUtf8(await encryptJwe(encodeUtf8(JSON.stringify(content)), key)),
    JOSE_CONTENT_TYPE
  );

  return {
    url,
    link: `#shlink:/${toBase64Url(
      encodeUtf8(JSON.stringify({ url, key: keyToBase64Url(key), v: 1, ...extra }))
    )}`
  };
}

const foreignKey = generateKey();
const foreignResponse: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  questionnaire: 'http://example.org/Questionnaire/test',
  subject: { reference: 'Patient/vault-local-42' },
  item: [{ linkId: 'q1', text: 'Any pain?', answer: [{ valueString: 'Occasionally' }] }]
};

// A bare resource, not a Bundle — an entirely ordinary `application/fhir+json` payload.
const bare = await hostShl(foreignResponse, foreignKey, { flag: 'U' });
const bareDecoded = await shlCodec.decode(bare.link);
check(
  'foreign/bareResourceNormalised',
  parseResponseBundle(bareDecoded.bundle).response.item?.[0].answer?.[0].valueString ===
    'Occasionally',
  'a filler that parks a QuestionnaireResponse rather than a Bundle has done nothing wrong'
);
check(
  'foreign/bareResourceIsNotARequest',
  !isRequestBundle(bareDecoded.bundle),
  'must route to review, not to the form filler'
);

/*
 * Manifest mode. Serve a POST manifest alongside the blob shim already installed, so the same
 * in-memory store backs both `location` reads and the manifest itself.
 */
let manifestFiles: { contentType: string; location?: string; embedded?: string }[] = [];
let manifestPasscode: string | undefined;
let manifestCalls = 0;
let lastManifestBody: Record<string, unknown> = {};
const MANIFEST_URL = 'https://manifest.test/shl/abc';

const blobShim = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === MANIFEST_URL) {
    manifestCalls++;
    lastManifestBody = JSON.parse(String(init?.body ?? '{}'));
    if (manifestPasscode !== undefined && lastManifestBody.passcode !== manifestPasscode) {
      return new Response(JSON.stringify({ remainingAttempts: 2 }), { status: 401 });
    }
    return new Response(JSON.stringify({ files: manifestFiles }), { status: 200 });
  }
  return blobShim(input as RequestInfo, init);
}) as typeof fetch;

const manifestLink = `#shlink:/${toBase64Url(
  encodeUtf8(JSON.stringify({ url: MANIFEST_URL, key: keyToBase64Url(foreignKey), v: 1 }))
)}`;

/** Encrypt `content` under the foreign key and host it, returning just the URL. */
const hostFile = async (content: unknown) =>
  (await hostShl(content, foreignKey)).url;

const foreignProvenance: Provenance = {
  resourceType: 'Provenance',
  target: [{ reference: 'QuestionnaireResponse/local' }],
  recorded: '2026-01-01T00:00:00Z',
  agent: [{ who: { reference: 'Patient/vault-local-42' } }]
};

// The answers in one file, the attribution in another. That is one payload, not a choice.
manifestFiles = [
  { contentType: 'application/fhir+json', location: await hostFile(bundleResponse(foreignResponse)) },
  { contentType: 'application/fhir+json', location: await hostFile(foreignProvenance) }
];

const mergedFiles = await shlCodec.decode(manifestLink);
const mergedPayload = parseResponseBundle(mergedFiles.bundle);
check(
  'foreign/manifestMergesAllFhirFiles',
  mergedPayload.response !== undefined && mergedPayload.provenance !== undefined,
  'taking only the first file drops the PATAST attribution that makes a reply safe to store'
);

// A file type this app cannot render must be reported, not silently dropped.
manifestFiles = [
  { contentType: 'application/fhir+json', location: await hostFile(bundleResponse(foreignResponse)) },
  { contentType: 'application/smart-health-card', location: await hostFile({ vc: {} }) }
];
const withCard = await shlCodec.decode(manifestLink);
check(
  'foreign/manifestIgnoresNonFhir',
  parseResponseBundle(withCard.bundle).response !== undefined
);
check(
  'foreign/manifestWarnsAboutSkipped',
  (withCard.warnings ?? []).some((warning) => warning.includes('smart-health-card')),
  (withCard.warnings ?? []).join(' | ')
);

// `application/fhir+json; charset=utf-8` is the same content type.
manifestFiles = [
  {
    contentType: 'application/fhir+json; charset=utf-8',
    location: await hostFile(bundleResponse(foreignResponse))
  }
];
check(
  'foreign/manifestToleratesContentTypeParameters',
  parseResponseBundle((await shlCodec.decode(manifestLink)).bundle).response !== undefined
);

// One unreadable file must cost its own content, not the whole link.
const corruptUrl = await store.put(encodeUtf8('not.a.valid.jwe.at-all'), JOSE_CONTENT_TYPE);
manifestFiles = [
  { contentType: 'application/fhir+json', location: corruptUrl },
  { contentType: 'application/fhir+json', location: await hostFile(bundleResponse(foreignResponse)) }
];
const partialRead = await shlCodec.decode(manifestLink);
check(
  'foreign/manifestSurvivesOneBadFile',
  parseResponseBundle(partialRead.bundle).response !== undefined
);
check(
  'foreign/manifestWarnsAboutBadFile',
  (partialRead.warnings ?? []).some((warning) => warning.includes('could not be read')),
  (partialRead.warnings ?? []).join(' | ')
);

// …but a manifest where nothing decoded is a broken link, not an empty one.
manifestFiles = [{ contentType: 'application/fhir+json', location: corruptUrl }];
let allBadRejected = false;
try {
  await shlCodec.decode(manifestLink);
} catch (error) {
  allBadRejected = error instanceof Error && error.message.includes('Nothing in this link');
}
check(
  'foreign/manifestAllBadThrows',
  allBadRejected,
  'reporting "no answers" for a link that failed to decrypt would be a lie'
);

// A request delivered by manifest must still read as a request.
const manifestRequest = buildRequestBundle(
  { resourceType: 'Questionnaire', status: 'active', url: 'http://example.org/Questionnaire/test' },
  { requestId: 'urn:uuid:manifest-request' }
);
manifestFiles = [
  { contentType: 'application/fhir+json', location: await hostFile(manifestRequest.bundle) }
];
check(
  'foreign/manifestRequestStillRoutesAsRequest',
  isRequestBundle((await shlCodec.decode(manifestLink)).bundle)
);

// An embedded file needs no second fetch.
manifestFiles = [
  {
    contentType: 'application/fhir+json',
    embedded: await encryptJwe(
      encodeUtf8(JSON.stringify(bundleResponse(foreignResponse))),
      foreignKey
    )
  }
];
check(
  'foreign/manifestReadsEmbedded',
  parseResponseBundle((await shlCodec.decode(manifestLink)).bundle).response !== undefined
);

// ---------------------------------------------------------------------------
// Passcodes.

console.log('\npasscode-protected links\n');

manifestPasscode = 'letmein';
manifestFiles = [
  { contentType: 'application/fhir+json', location: await hostFile(bundleResponse(foreignResponse)) }
];

let passcodeError: unknown;
try {
  await shlCodec.decode(manifestLink, { passcode: 'wrong' });
} catch (error) {
  passcodeError = error;
}
check('passcode/manifest401ThrowsTyped', passcodeError instanceof PasscodeRequiredError);
check(
  'passcode/reportsRemainingAttempts',
  (passcodeError as PasscodeRequiredError)?.remainingAttempts === 2
);
check('passcode/knowsItWasAttempted', (passcodeError as PasscodeRequiredError)?.wasAttempted === true);

check(
  'passcode/correctPasscodeSucceeds',
  parseResponseBundle((await shlCodec.decode(manifestLink, { passcode: 'letmein' })).bundle)
    .response !== undefined
);
check('passcode/reachesTheManifestBody', lastManifestBody.passcode === 'letmein');
check(
  'passcode/recipientOverridable',
  ((await shlCodec.decode(manifestLink, { passcode: 'letmein', recipient: 'Someone Else' })) &&
    lastManifestBody.recipient === 'Someone Else') === true
);

/*
 * A `P`-flagged link must ask before it knocks. A manifest server may count a passcode-less request
 * as a failed attempt and lock the link permanently, so spending one of a patient's attempts to
 * discover something the payload already states would be inexcusable.
 */
const pFlagLink = `#shlink:/${toBase64Url(
  encodeUtf8(
    JSON.stringify({ url: MANIFEST_URL, key: keyToBase64Url(foreignKey), flag: 'P', v: 1 })
  )
)}`;

const callsBeforePreempt = manifestCalls;
let preempted: unknown;
try {
  await shlCodec.decode(pFlagLink);
} catch (error) {
  preempted = error;
}
check('passcode/pFlagPreemptsWithoutRequest', preempted instanceof PasscodeRequiredError);
check(
  'passcode/pFlagKnowsNothingWasTried',
  (preempted as PasscodeRequiredError)?.wasAttempted === false
);
check(
  'passcode/pFlagCostsNoAttempt',
  manifestCalls === callsBeforePreempt,
  'burning an attempt to learn what the payload already says would be inexcusable'
);
check(
  'passcode/pFlagOpensWhenSupplied',
  parseResponseBundle((await shlCodec.decode(pFlagLink, { passcode: 'letmein' })).bundle)
    .response !== undefined
);

manifestPasscode = undefined;
globalThis.fetch = realFetch;

// The optional argument must not have disturbed the other codec's narrower signature.
const bespokeWithOptions = await bespokeCodec.encode(
  { bundle: bundleResponse(foreignResponse), label: 'unaffected' },
  { baseUrl: BASE_URL }
);
check(
  'passcode/bespokeSignatureUnaffected',
  responseFromBundle((await bespokeCodec.decode(bespokeWithOptions, { passcode: 'x' })).bundle)
    .status === 'completed'
);

// ---------------------------------------------------------------------------
// Reply crypto (ECDH-ES + A256GCM) — channel C.
//
// Cross-checked against an independent `node:crypto` implementation in BOTH directions, rather than
// only round-tripping against itself. A self-consistent implementation of the wrong Concat-KDF passes
// its own round trip perfectly and cannot talk to anyone; only an independent implementation catches
// that. The one below is transcribed from Platypus's `scripts/shl-invite.mjs`, which is the practice
// side of its connectathon demo, so agreement here is agreement with the app we have to interoperate
// with.
// ---------------------------------------------------------------------------

console.log('\nreply crypto (ECDH-ES + A256GCM)\n');

const nodeB64u = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url');
const nodeFromB64u = (value: string) => Buffer.from(value, 'base64url');

function nodeConcatKdf(z: Buffer): Buffer {
  const lengthPrefixed = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const suppPubInfo = Buffer.alloc(4);
  suppPubInfo.writeUInt32BE(256);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(1);

  return createHash('sha256')
    .update(
      Buffer.concat([
        counter,
        z,
        Buffer.concat([
          lengthPrefixed(Buffer.from('A256GCM', 'ascii')),
          lengthPrefixed(Buffer.alloc(0)),
          lengthPrefixed(Buffer.alloc(0)),
          suppPubInfo
        ])
      ])
    )
    .digest();
}

const jwkToPoint = (jwk: { x: string; y: string }) =>
  Buffer.concat([Buffer.from([0x04]), nodeFromB64u(jwk.x), nodeFromB64u(jwk.y)]);

function nodeEncryptReply(plaintext: string, recipient: { x: string; y: string }): string {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const point = ecdh.getPublicKey();
  const epk = {
    kty: 'EC',
    crv: 'P-256',
    x: nodeB64u(point.subarray(1, 33)),
    y: nodeB64u(point.subarray(33, 65))
  };
  const cek = nodeConcatKdf(ecdh.computeSecret(jwkToPoint(recipient)));
  const iv = randomBytes(12);
  const header = nodeB64u(Buffer.from(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM', epk })));
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);

  return [header, '', nodeB64u(iv), nodeB64u(ciphertext), nodeB64u(cipher.getAuthTag())].join('.');
}

function nodeDecryptReply(jwe: string, privateJwk: { d: string }): string {
  const [header, encryptedKey, iv, ciphertext, tag] = jwe.split('.');
  if (encryptedKey !== '') {
    throw new Error('expected an empty encrypted-key segment');
  }

  const parsed = JSON.parse(nodeFromB64u(header).toString('utf8'));
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(nodeFromB64u(privateJwk.d));
  const cek = nodeConcatKdf(ecdh.computeSecret(jwkToPoint(parsed.epk)));
  const decipher = createDecipheriv('aes-256-gcm', cek, nodeFromB64u(iv));
  decipher.setAAD(Buffer.from(header, 'ascii'));
  decipher.setAuthTag(nodeFromB64u(tag));

  return Buffer.concat([decipher.update(nodeFromB64u(ciphertext)), decipher.final()]).toString('utf8');
}

const replyKeys = await generateReplyKeyPair();
check('reply/publicJwkIsMinimal', Object.keys(replyKeys.publicJwk).sort().join(',') === 'crv,kty,x,y', Object.keys(replyKeys.publicJwk).join(','));
check('reply/curveIsP256', replyKeys.publicJwk.crv === 'P-256');

const replyMessage = JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: [] });
const replyJwe = await encryptReplyJwe(encodeUtf8(replyMessage), replyKeys.publicJwk);
const replySegments = replyJwe.split('.');

check('reply/fiveSegments', replySegments.length === 5, `${replySegments.length}`);
check('reply/encryptedKeySegmentEmpty', replySegments[1] === '');

const replyHeader = JSON.parse(decodeUtf8(fromBase64Url(replySegments[0])));
check('reply/algIsEcdhEs', replyHeader.alg === 'ECDH-ES', String(replyHeader.alg));
check('reply/encIsA256Gcm', replyHeader.enc === 'A256GCM', String(replyHeader.enc));
check('reply/headerCarriesEphemeralKey', replyHeader.epk?.crv === 'P-256' && typeof replyHeader.epk?.x === 'string');
check('reply/headerHasNoPrivateKey', replyHeader.epk?.d === undefined, 'an epk with `d` would publish the sender key');
check('reply/noApuApv', replyHeader.apu === undefined && replyHeader.apv === undefined);

check('reply/roundTrip', decodeUtf8(await decryptReplyJwe(replyJwe, replyKeys.privateJwk)) === replyMessage);

// The interop assertions that actually matter.
check('reply/interop:oursDecryptedByNode', nodeDecryptReply(replyJwe, replyKeys.privateJwk) === replyMessage);
check(
  'reply/interop:nodeDecryptedByOurs',
  decodeUtf8(await decryptReplyJwe(nodeEncryptReply(replyMessage, replyKeys.publicJwk), replyKeys.privateJwk)) ===
    replyMessage
);

// A key generated the way Platypus generates its practice key must work with our implementation.
const foreignEcdh = createECDH('prime256v1');
foreignEcdh.generateKeys();
const foreignPoint = foreignEcdh.getPublicKey();
const foreignPublic = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: nodeB64u(foreignPoint.subarray(1, 33)),
  y: nodeB64u(foreignPoint.subarray(33, 65))
};
const foreignPrivate = { ...foreignPublic, d: nodeB64u(foreignEcdh.getPrivateKey()) };
check(
  'reply/interop:foreignKeyPair',
  decodeUtf8(
    await decryptReplyJwe(await encryptReplyJwe(encodeUtf8(replyMessage), foreignPublic), foreignPrivate)
  ) === replyMessage
);

async function replyRejects(mutate: (segments: string[]) => string[] | Promise<string[]>, key = replyKeys.privateJwk) {
  try {
    await decryptReplyJwe((await mutate([...replySegments])).join('.'), key);
    return false;
  } catch {
    return true;
  }
}

check('reply/wrongKeyRejected', await replyRejects((segments) => segments, (await generateReplyKeyPair()).privateJwk));
check(
  'reply/tamperedCiphertextRejected',
  await replyRejects((segments) => {
    const bytes = fromBase64Url(segments[3]);
    bytes[0] ^= 0xff;
    segments[3] = toBase64Url(bytes);
    return segments;
  })
);
check(
  'reply/tamperedEpkRejected',
  await replyRejects(async (segments) => {
    const header = JSON.parse(decodeUtf8(fromBase64Url(segments[0])));
    header.epk = (await generateReplyKeyPair()).publicJwk;
    segments[0] = toBase64Url(encodeUtf8(JSON.stringify(header)));
    return segments;
  })
);
// `dir` and `ECDH-ES` must not be interchangeable: accepting a `dir` header here would let anyone who
// has the link's symmetric key read a reply.
check(
  'reply/rejectsDirAlg',
  await replyRejects((segments) => {
    segments[0] = toBase64Url(encodeUtf8(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })));
    return segments;
  })
);

check('reply/looksLikeReplyJwe:accepts', looksLikeReplyJwe(replyJwe));
check('reply/looksLikeReplyJwe:rejectsPending', !looksLikeReplyJwe(replySlotPlaceholder()));
// A fixed placeholder makes every slot after the first a byte-identical create, which servers that
// deduplicate reject (HAPI-2840). Uniqueness is what stops the second request ever minted failing.
check(
  'reply/slotPlaceholderIsUnique',
  replySlotPlaceholder() !== replySlotPlaceholder(),
  'identical placeholders collide on servers that deduplicate creates'
);

// ---------------------------------------------------------------------------
// Reply descriptor — build, parse, and tolerance of Platypus's own identifiers.
// ---------------------------------------------------------------------------

console.log('\nreply descriptor\n');

const descriptor = {
  replyUrl: 'https://blobs.test/Binary/42',
  replyMethod: 'PUT' as const,
  publicJwk: replyKeys.publicJwk,
  expiresAt: Math.floor(Date.now() / 1000) + 86400
};

const descriptorTask: Task = {
  resourceType: 'Task',
  status: 'requested',
  intent: 'order',
  extension: [buildReplyDescriptorExtension(descriptor), buildServerTaskUrlExtension('https://ehr.test/fhir/Task/7')]
};

const parsedDescriptor = parseReplyDescriptor(descriptorTask);
check('descriptor/roundTripsUrl', parsedDescriptor?.replyUrl === descriptor.replyUrl);
check('descriptor/roundTripsMethod', parsedDescriptor?.replyMethod === 'PUT');
check(
  'descriptor/roundTripsKey',
  JSON.stringify(parsedDescriptor?.publicJwk) === JSON.stringify(replyKeys.publicJwk)
);
check('descriptor/roundTripsExpiry', parsedDescriptor?.expiresAt === descriptor.expiresAt);
check('descriptor/serverTaskUrl', parseServerTaskUrl(descriptorTask) === 'https://ehr.test/fhir/Task/7');

// The private key must never end up in a descriptor, however the caller was holding it.
check(
  'descriptor/carriesNoPrivateKey',
  !JSON.stringify(descriptorTask).includes(replyKeys.privateJwk.d),
  'a descriptor holding `d` would let anyone with the link read the reply'
);

// A Platypus-minted descriptor: its extension URL, its `replyPostToken` field name, `valueString` for
// the URL, and no `replyMethod` at all.
const platypusTask: Task = {
  resourceType: 'Task',
  status: 'requested',
  intent: 'order',
  extension: [
    {
      url: 'https://platypushealth.app/StructureDefinition/shl-reply-descriptor',
      extension: [
        { url: 'replyUrl', valueString: 'https://relay.test/shl/reply-slots/abc' },
        { url: 'replyPostToken', valueString: 'token-xyz' },
        { url: 'publicJwk', valueString: JSON.stringify(replyKeys.publicJwk) },
        { url: 'expiresAt', valueInteger: 1893456000 }
      ]
    },
    {
      url: 'https://platypushealth.app/StructureDefinition/invitation-server-task-url',
      valueString: 'https://practice.test/fhir/Task/99'
    }
  ]
};

const parsedPlatypus = parseReplyDescriptor(platypusTask);
check('descriptor/readsPlatypusExtensionUrl', parsedPlatypus !== undefined);
check('descriptor/readsValueStringUrl', parsedPlatypus?.replyUrl === 'https://relay.test/shl/reply-slots/abc');
check('descriptor/readsReplyPostTokenAlias', parsedPlatypus?.replyToken === 'token-xyz');
check(
  'descriptor/inferrsRelayWhenUntyped',
  parsedPlatypus?.replyMethod === 'relay-grant',
  'a tokened descriptor with no replyMethod is a relay, and must not be PUT at blindly'
);
check('descriptor/readsPlatypusServerTaskUrl', parseServerTaskUrl(platypusTask) === 'https://practice.test/fhir/Task/99');

// Malformed descriptors degrade to "no reply channel" rather than breaking the receive flow.
const partial: Task = {
  resourceType: 'Task',
  status: 'requested',
  intent: 'order',
  extension: [
    {
      url: REPLY_DESCRIPTOR_EXTENSION,
      extension: [{ url: 'replyUrl', valueUrl: 'https://blobs.test/Binary/1' }]
    }
  ]
};
check('descriptor/partialIsIgnored', parseReplyDescriptor(partial) === undefined, 'missing publicJwk');
check('descriptor/absentIsUndefined', parseReplyDescriptor({ resourceType: 'Task', status: 'requested', intent: 'order' }) === undefined);
check(
  'descriptor/badJwkIsIgnored',
  parseReplyDescriptor({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    extension: [
      {
        url: REPLY_DESCRIPTOR_EXTENSION,
        extension: [
          { url: 'replyUrl', valueUrl: 'https://blobs.test/Binary/1' },
          { url: 'publicJwk', valueString: '{"kty":"RSA"}' }
        ]
      }
    ]
  }) === undefined,
  'a non-P-256 key must not be accepted'
);
check('descriptor/expiryHonoured', isReplyDescriptorExpired({ ...descriptor, expiresAt: 1 }));
check('descriptor/unexpiredIsUsable', !isReplyDescriptorExpired(descriptor));

// ---------------------------------------------------------------------------
// Write descriptor (channel D) — build, parse, tolerance, and the invariants that
// keep a write capability out of everything it must not appear in.
// ---------------------------------------------------------------------------

console.log('\nwrite descriptor\n');

const writeDescriptor = {
  writeUrl: 'https://blobs.test/fhir/QuestionnaireResponse/4821',
  writeMethod: 'PUT' as const,
  writeEtag: 'W/"1"',
  writeToken: 'write-token-abc',
  expiresAt: Math.floor(Date.now() / 1000) + 86400
};

const writeTask: Task = {
  resourceType: 'Task',
  status: 'requested',
  intent: 'order',
  identifier: [{ system: 'urn:ietf:rfc:3986', value: 'urn:uuid:3fb1cde7-0000-4000-8000-000000000001' }],
  for: { reference: 'Patient/137287372', display: 'Jane Citizen' },
  extension: [buildWriteDescriptorExtension(writeDescriptor)]
};

const parsedWrite = parseWriteDescriptor(writeTask);
check('write/roundTripsUrl', parsedWrite?.writeUrl === writeDescriptor.writeUrl);
check('write/roundTripsMethod', parsedWrite?.writeMethod === 'PUT');
check('write/roundTripsEtag', parsedWrite?.writeEtag === 'W/"1"');
check('write/roundTripsToken', parsedWrite?.writeToken === 'write-token-abc');
check('write/roundTripsExpiry', parsedWrite?.expiresAt === writeDescriptor.expiresAt);
check('write/expiryHonoured', isWriteDescriptorExpired({ ...writeDescriptor, expiresAt: 1 }));
check('write/unexpiredIsUsable', !isWriteDescriptorExpired(writeDescriptor));

check(
  'write/slotIdFromUrl',
  writeSlotId(writeDescriptor.writeUrl) === '4821',
  'a FHIR update requires the body id to match the URL, so this has to be exact'
);

// Tolerance: anything we cannot use reads as "no write channel", never as an error.
check(
  'write/absentIsUndefined',
  parseWriteDescriptor({ resourceType: 'Task', status: 'requested', intent: 'order' }) === undefined
);
check(
  'write/missingUrlIsIgnored',
  parseWriteDescriptor({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    extension: [{ url: WRITE_DESCRIPTOR_EXTENSION, extension: [{ url: 'writeEtag', valueString: 'W/"1"' }] }]
  }) === undefined
);
check(
  'write/unknownMethodIsIgnored',
  parseWriteDescriptor({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    extension: [
      {
        url: WRITE_DESCRIPTOR_EXTENSION,
        extension: [
          { url: 'writeUrl', valueUrl: 'https://blobs.test/fhir/QuestionnaireResponse/1' },
          { url: 'writeMethod', valueCode: 'relay-grant' }
        ]
      }
    ]
  }) === undefined,
  'a delivery method we do not implement is a channel to decline, not one to attempt anyway'
);

// A Platypus-minted write descriptor, under their namespace and using valueString.
check(
  'write/readsPlatypusExtensionUrl',
  parseWriteDescriptor({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    extension: [
      {
        url: 'https://platypushealth.app/StructureDefinition/shl-write-descriptor',
        extension: [
          { url: 'writeUrl', valueString: 'https://practice.test/fhir/QuestionnaireResponse/9' },
          { url: 'writeEtag', valueString: 'W/"3"' }
        ]
      }
    ]
  })?.writeEtag === 'W/"3"'
);

// Unsafe addresses are dropped at the parse, so no UI ever offers a send that cannot work.
check('write/rejectsCleartext', !isSafeWriteUrl('http://blobs.test/fhir/QuestionnaireResponse/1'));
check('write/rejectsLoopback', !isSafeWriteUrl('https://localhost:8443/fhir/QuestionnaireResponse/1'));
check('write/rejects127', !isSafeWriteUrl('https://127.0.0.1/fhir/QuestionnaireResponse/1'));
check(
  'write/rejectsLinkLocal',
  !isSafeWriteUrl('https://169.254.169.254/latest/meta-data'),
  'the cloud metadata address is the one a forged invitation would most like a filler to reach'
);
check('write/acceptsHttps', isSafeWriteUrl(writeDescriptor.writeUrl));
check(
  'write/unsafeUrlIsNoChannel',
  parseWriteDescriptor({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    extension: [
      {
        url: WRITE_DESCRIPTOR_EXTENSION,
        extension: [{ url: 'writeUrl', valueUrl: 'http://127.0.0.1/fhir/QuestionnaireResponse/1' }]
      }
    ]
  }) === undefined
);

// Both channels on one Task must both be readable — a request may offer either, both, or neither.
const bothChannels = parseReturnChannels({
  ...writeTask,
  extension: [
    buildReplyDescriptorExtension(descriptor),
    buildWriteDescriptorExtension(writeDescriptor),
    buildServerTaskUrlExtension('https://ehr.test/fhir/Task/7')
  ]
});
check('write/coexistsWithReply', bothChannels.reply !== undefined && bothChannels.write !== undefined);
check('write/coexistsWithServerTaskUrl', bothChannels.serverTaskUrl === 'https://ehr.test/fhir/Task/7');

// The written resource.
const writeWire = buildWriteResponse(
  {
    resourceType: 'QuestionnaireResponse',
    id: 'local-vault-key-77',
    status: 'in-progress',
    questionnaire: 'http://example.org/Q|1.0',
    subject: { reference: 'Patient/local-vault-key', display: 'Someone Else' },
    author: { reference: 'Patient/local-vault-key' },
    item: [{ linkId: '1', answer: [{ valueString: 'yes' }] }]
  },
  { requestTask: writeTask }
);

check('write/wireIsCompleted', writeWire.status === 'completed');
check(
  'write/wireDropsLocalId',
  writeWire.id === undefined,
  'the slot id is applied at the PUT; a filler id here would address the wrong resource'
);
check(
  'write/wireIsPatientAsserted',
  (writeWire.meta?.security ?? []).some((coding) => coding.code === 'PATAST'),
  'with no Provenance to send, this label is the whole attribution story'
);
check(
  'write/wireDropsUnresolvableSubjectReference',
  writeWire.subject?.reference === undefined,
  'a filler patient id fails the slot write outright (HAPI-1094), stranding the answers'
);
check(
  'write/wireKeepsSubjectName',
  writeWire.subject?.display === 'Jane Citizen',
  'the name is the only part of who the answers are about that survives'
);
check(
  'write/wireCorrelatesByIdentifier',
  writeWire.identifier?.value === 'urn:uuid:3fb1cde7-0000-4000-8000-000000000001',
  'there is no Task echo on this channel, so the identifier is the correlation key'
);
check('write/wireKeepsAnswers', writeWire.item?.[0]?.answer?.[0]?.valueString === 'yes');

// The three places a write token must never appear.
const writeRequest = buildRequestBundle(
  { resourceType: 'Questionnaire', status: 'active', url: 'http://example.org/Q', version: '1.0', title: 'Probe' },
  { requestId: 'write-invariants', writeDescriptor }
);
check(
  'write/tokenTravelsInsideThePayload',
  JSON.stringify(writeRequest.bundle).includes(writeDescriptor.writeToken),
  'the descriptor is what the filler reads; it has to be in the encrypted payload'
);
check(
  'write/tokenNotOnPublishedTask',
  !JSON.stringify(asPublishedTask(writeRequest.task)).includes(writeDescriptor.writeToken),
  'a token on a server whose purpose is to be readable is a token given away'
);
check(
  'write/tokenNotEchoedOnReturn',
  !JSON.stringify(buildResponseBundle(writeWire, writeRequest.task).bundle).includes(
    writeDescriptor.writeToken
  ),
  'echoing it back copies a write capability into whatever the answers travel on, possibly a plain QR'
);

/*
 * Platypus's own parser, ported verbatim from `apps/mobile/lib/shl-write.ts` and
 * `apps/mobile/lib/shl-invitation.ts` (`parseWriteDescriptor`).
 *
 * Channel D is specified here and implemented there, which is the reverse of channel C, and it makes
 * this the more important direction to guard: a change to what we emit that their parser stops
 * accepting is invisible from this side. The form still opens there, it just silently loses the
 * return channel and falls back to a QR the patient may have nobody to show.
 */
function platypusParseWriteDescriptor(task: Task):
  | { writeUrl: string; writeEtag?: string; writeToken?: string; expiresAt?: number }
  | undefined {
  const urls = [
    'https://platypushealth.app/StructureDefinition/shl-write-descriptor',
    'http://smartforms.csiro.au/StructureDefinition/shl-write-descriptor'
  ];
  const ext = task?.extension?.find((e) => urls.includes(e.url ?? ''));
  if (!ext?.extension) return undefined;
  const sub = ext.extension;
  const str = (url: string): string | undefined => {
    const found = sub.find((e) => e.url === url);
    return found?.valueUrl ?? found?.valueString;
  };

  const url = str('writeUrl');
  if (!url) return undefined;

  const method = sub.find((e) => e.url === 'writeMethod')?.valueCode;
  if (method !== undefined && method !== 'PUT') return undefined;

  const writeEtag = str('writeEtag');
  const writeToken = str('writeToken');
  const expiresAt = sub.find((e) => e.url === 'expiresAt')?.valueInteger;

  return {
    writeUrl: url,
    ...(writeEtag ? { writeEtag } : {}),
    ...(writeToken ? { writeToken } : {}),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {})
  };
}

/** Verbatim port of Platypus's `writeSlotId`. */
function platypusWriteSlotId(writeUrl: string): string | undefined {
  const id = writeUrl.split(/[?#]/, 1)[0]?.replace(/\/+$/, '').split('/').pop();
  return id !== undefined && id !== '' ? id : undefined;
}

const platypusRead = platypusParseWriteDescriptor(writeTask);
check(
  'write/platypusReadsOurDescriptor',
  platypusRead !== undefined,
  'we specify this channel; if their parser stops accepting what we emit, nobody here finds out'
);
check('write/platypusReadsOurUrl', platypusRead?.writeUrl === writeDescriptor.writeUrl);
check(
  'write/platypusReadsOurEtag',
  platypusRead?.writeEtag === writeDescriptor.writeEtag,
  'without the ETag their write is unconditional, and the single-use guarantee is gone'
);
check('write/platypusReadsOurToken', platypusRead?.writeToken === writeDescriptor.writeToken);
check(
  'write/platypusDerivesTheSameSlotId',
  platypusWriteSlotId(writeDescriptor.writeUrl) === writeSlotId(writeDescriptor.writeUrl),
  'a FHIR update writes to the id in the URL; disagreeing here means every write is rejected'
);
check(
  'write/platypusReadsAMintedRequest',
  platypusParseWriteDescriptor(writeRequest.task)?.writeUrl === writeDescriptor.writeUrl,
  'asserted against a Task from buildRequestBundle, not a hand-built fixture'
);

// ---------------------------------------------------------------------------
// The Platypus detection contract.
//
// Replicated from `apps/mobile/lib/sdc-requested.ts` (`questionnaireRefFromTask`) and
// `apps/mobile/lib/shl-invitation.ts` (`taskTargetsQuestionnaire`) so a change to how our Task names
// its Questionnaire cannot silently stop a third party recognising our invitations. Without this the
// failure mode is invisible from here: the form still opens, it just loses its Task, its addressing and
// every return channel — degrading to a form nobody can send back.
// ---------------------------------------------------------------------------

console.log('\nplatypus detection contract\n');

/** Verbatim port of Platypus's `questionnaireRefFromTask`. */
function questionnaireRefFromTask(task: Task): string | undefined {
  const focus = task.focus?.reference;
  if (focus && /questionnaire/i.test(focus)) return focus;
  if (focus && task.focus?.type === 'Questionnaire') return focus;

  for (const input of task.input ?? []) {
    const typeCode = input.type?.coding?.[0]?.code ?? input.type?.text;
    const isQuestionnaire =
      (typeCode && ['questionnaire', 'Questionnaire'].includes(typeCode)) || input.valueCanonical != null;
    if (!isQuestionnaire) continue;
    if (input.valueCanonical) return input.valueCanonical;
    const ref = input.valueReference?.reference;
    if (ref) return ref;
  }

  const reason = task.reasonReference?.reference;
  if (reason && /questionnaire/i.test(reason)) return reason;

  return undefined;
}

/** Verbatim port of Platypus's `refMatchesQuestionnaire` + `taskTargetsQuestionnaire`. */
function taskTargetsQuestionnaire(task: Task, q: Questionnaire): boolean {
  const matches = (ref: string | undefined) => {
    if (!ref) return false;
    const canonical = ref.split('|')[0];
    return ref === q.url || canonical === q.url || ref === q.id || (q.id != null && ref === `Questionnaire/${q.id}`);
  };

  return matches(questionnaireRefFromTask(task)) || matches(task.focus?.reference);
}

const detectionQuestionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  id: 'detection-test',
  url: 'http://example.org/Questionnaire/detection',
  version: '1.2',
  status: 'active',
  title: 'Detection contract',
  item: [{ linkId: 'q1', type: 'string', text: 'Anything' }]
};

const { bundle: detectionBundle, task: detectionTask } = buildRequestBundle(detectionQuestionnaire, {
  subjectReference: 'Patient/123',
  subjectDisplay: 'Jane Citizen',
  requesterDisplay: 'Parkview Medical Centre',
  replyDescriptor: descriptor
});

check('detection/taskIsRequested', detectionTask.status === 'requested', detectionTask.status);
check(
  'detection/questionnaireRefResolves',
  questionnaireRefFromTask(detectionTask) === 'http://example.org/Questionnaire/detection|1.2',
  String(questionnaireRefFromTask(detectionTask))
);
check(
  'detection/taskTargetsQuestionnaire',
  taskTargetsQuestionnaire(detectionTask, detectionQuestionnaire),
  'if this fails, third parties see a form with no request behind it'
);
check(
  'detection/focusIsCanonicalNotUrnUuid',
  detectionTask.focus?.reference === 'http://example.org/Questionnaire/detection|1.2' &&
    detectionTask.focus?.type === 'Questionnaire',
  String(detectionTask.focus?.reference)
);
check(
  'detection/inputKeepsCanonical',
  detectionTask.input?.[0]?.valueCanonical === 'http://example.org/Questionnaire/detection|1.2',
  'the return leg drops `focus`, so `input` is what survives'
);
check('detection/addresseeIsReadable', detectionTask.for?.display === 'Jane Citizen');
check('detection/senderIsReadable', detectionTask.requester?.display === 'Parkview Medical Centre');
check('detection/descriptorOnTask', parseReplyDescriptor(detectionTask)?.replyUrl === descriptor.replyUrl);

// Platypus flattens a Bundle into a resource list and looks for a Questionnaire to decide that an SHL
// is a form invitation rather than a records import.
const flattened = (detectionBundle.entry ?? []).map((entry) => entry.resource!);
check('detection/bundleFlattensToResources', flattened.length === 2, `${flattened.length} resources`);
check('detection/questionnairePresent', flattened.some((r) => r.resourceType === 'Questionnaire'));
check(
  'detection/taskFoundByStatus',
  flattened.some((r) => r.resourceType === 'Task' && (r as Task).status === 'requested')
);

// A Questionnaire with no canonical cannot be named by reference at all; it must still produce a
// readable request rather than throwing.
const { task: urnTask } = buildRequestBundle({
  resourceType: 'Questionnaire',
  id: 'no-canonical',
  status: 'active',
  item: [{ linkId: 'q1', type: 'string' }]
});
check('detection/noCanonicalStillBuilds', urnTask.focus?.reference?.startsWith('urn:uuid:') === true);
check('detection/noCanonicalHasNoFocusType', urnTask.focus?.type === undefined, 'a type here would short-circuit the input lookup');

/*
 * The negative case, without which the positive ones above prove nothing: a `focus.type` of
 * 'Questionnaire' alongside a `urn:uuid` reference must NOT be detectable. This is the exact
 * half-change that looks like a tidy-up — "the focus is a Questionnaire, so say so" — and silently
 * costs every third-party filler its Task. It is asserted as a failure so that anyone who reintroduces
 * it sees why, rather than discovering it from a connectathon.
 */
check(
  'detection/urnUuidFocusWithTypeIsNotDetectable',
  !taskTargetsQuestionnaire(
    { ...detectionTask, focus: { reference: 'urn:uuid:0000', type: 'Questionnaire' } },
    detectionQuestionnaire
  ),
  'setting focus.type without moving focus.reference to the canonical breaks detection'
);
check(
  'detection/urnUuidFocusWithoutTypeStillWorks',
  taskTargetsQuestionnaire(
    { ...detectionTask, focus: { reference: 'urn:uuid:0000' } },
    detectionQuestionnaire
  ),
  'the input canonical is the fallback that saved the previous shape'
);

// ---------------------------------------------------------------------------
// Reply bundle — the wire shape a third-party filler sends back.
// ---------------------------------------------------------------------------

console.log('\nreply bundle\n');

const answered: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  id: 'local-vault-id',
  status: 'completed',
  questionnaire: 'http://example.org/Questionnaire/detection|1.2',
  subject: { reference: 'Patient/vault-local-key' },
  author: { reference: 'Patient/vault-local-key' },
  meta: { versionId: '3', lastUpdated: '2020-01-01T00:00:00Z' },
  item: [{ linkId: 'q1', answer: [{ valueString: 'an answer' }] }]
};

const { bundle: replyBundle, provenance: replyProvenance } = buildReplyBundle(answered, {
  requestTask: detectionTask
});
const replyPayload = parseResponseBundle(replyBundle);

check('replyBundle/hasResponse', replyPayload.response.resourceType === 'QuestionnaireResponse');
check('replyBundle/localIdStripped', replyPayload.response.id === undefined, 'a foreign id could collide on the requester server');
check(
  'replyBundle/patientAsserted',
  (replyPayload.response.meta?.security ?? []).some((coding) => coding.code === 'PATAST'),
  'without this, patient-entered answers read as clinician-recorded'
);
check('replyBundle/hasProvenance', replyPayload.provenance !== undefined);
check('replyBundle/provenanceTargetsResponse', replyProvenance?.target?.[0]?.reference === replyBundle.entry?.[0]?.fullUrl);
check('replyBundle/provenanceNamesPatient', replyProvenance?.agent?.[0]?.who?.reference === 'Patient/vault-local-key');
check('replyBundle/taskCompleted', replyPayload.task?.status === 'completed', replyPayload.task?.status);
check('replyBundle/correlationSurvives', taskCorrelationId(replyPayload.task) === taskCorrelationId(detectionTask));
check(
  'replyBundle/descriptorNotEchoedBack',
  parseReplyDescriptor(replyPayload.task) === undefined &&
    !JSON.stringify(replyBundle).includes(descriptor.replyUrl),
  'returning the slot URL and its token would copy a write capability into the response'
);
check('replyBundle/noDanglingFocus', replyPayload.task?.focus === undefined);

// ---------------------------------------------------------------------------
// Attribution must survive the write. `asNewResource` is not exported, so this exercises the
// observable behaviour: what `submitResponse` sends to the server.
// ---------------------------------------------------------------------------

console.log('\nattribution on write\n');

const posted: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (init?.method === 'POST') {
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ resourceType: url.split('/').pop(), id: `created-${posted.length}` }), {
      status: 201,
      headers: { 'Content-Type': 'application/fhir+json' }
    });
  }
  // The subject probe: pretend the patient does not exist, as a real destination server would.
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const submitted = await submitResponse({
  response: replyPayload.response,
  task: replyPayload.task,
  provenance: replyPayload.provenance,
  responseServerUrl: 'https://ehr.test/fhir'
});

const postedResponse = posted.find((entry) => entry.url.endsWith('/QuestionnaireResponse'))?.body as
  | QuestionnaireResponse
  | undefined;
const postedProvenance = posted.find((entry) => entry.url.endsWith('/Provenance'))?.body as
  | Provenance
  | undefined;

check('write/responseCreated', submitted[0]?.responseId !== undefined, submitted[0]?.error);
check(
  'write/securityLabelPreserved',
  (postedResponse?.meta?.security ?? []).some((coding) => coding.code === 'PATAST'),
  'stripping meta wholesale would silently drop the patient-asserted label'
);
check('write/versionIdStripped', postedResponse?.meta?.versionId === undefined);
check('write/lastUpdatedStripped', postedResponse?.meta?.lastUpdated === undefined);
check('write/idStripped', postedResponse?.id === undefined);
check('write/provenanceCreated', submitted[0]?.provenanceId !== undefined);
check(
  'write/provenanceRetargetedToRealId',
  postedProvenance?.target?.[0]?.reference === `QuestionnaireResponse/${submitted[0]?.responseId}`,
  postedProvenance?.target?.[0]?.reference
);
check('write/subjectProbeDetectsMissingPatient', (await referenceResolves('https://ehr.test/fhir', 'Patient/vault-local-key')) === false);
check(
  'write/subjectProbeToleratesAbsoluteRefs',
  (await referenceResolves('https://ehr.test/fhir', 'https://elsewhere.test/Patient/1')) === true,
  'an absolute reference is not ours to resolve'
);

// The endpoint declaration channel B relies on.
const declared = declareResponseEndpoint(detectionQuestionnaire, 'https://ehr.test/fhir');
check('write/endpointDeclared', declaredEndpoints(declared).includes('https://ehr.test/fhir'));
check('write/endpointDeclarationIsIdempotent', declaredEndpoints(declareResponseEndpoint(declared, 'https://ehr.test/fhir')).length === 1);
check(
  'write/catalogueQuestionnaireUntouched',
  declaredEndpoints(detectionQuestionnaire).length === 0,
  'the forms server copy must never be mutated'
);
check(
  'write/declaredEndpointOutranksConfig',
  resolveDestinations({ questionnaire: declared, responseServerUrl: 'https://other.test/fhir' }).join() ===
    'https://ehr.test/fhir'
);

globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// The published request Task — the copy that lands on the EHR so sent requests can be listed back.
//
// It differs from the invitation copy in three ways, and one of them is a hard server constraint rather
// than a preference, so it is asserted rather than assumed.
// ---------------------------------------------------------------------------

console.log('\npublished request task\n');

const published = asPublishedTask(detectionTask);

/*
 * The load-bearing one. The invitation names the Questionnaire by canonical because that is the only
 * form of the reference a filler can still use once the Bundle is taken apart — but `Task.focus` is a
 * `Reference`, and a FHIR server will not store a canonical there:
 *
 *   HAPI-0506: Invalid resource reference found at path[Task.focus] — Resource type is unknown or not
 *              supported on this server — http://example.org/Questionnaire/detection|1.2
 *
 * So the published copy drops `focus` and relies on `input[].valueCanonical`, which is a `canonical`
 * and stores fine. Reinstating `focus` here makes every request creation fail with a 400.
 */
check(
  'published/focusDropped',
  published.focus === undefined,
  'a canonical in Task.focus is rejected by FHIR servers (HAPI-0506)'
);
check(
  'published/canonicalStillRecorded',
  published.input?.[0]?.valueCanonical === 'http://example.org/Questionnaire/detection|1.2',
  'input[].valueCanonical is a canonical, not a Reference, so it stores'
);
check(
  'published/noExtensions',
  published.extension === undefined,
  'the reply descriptor and any write token must not reach a readable server'
);
check(
  'published/carriesNoReplyUrl',
  !JSON.stringify(published).includes(descriptor.replyUrl) &&
    !JSON.stringify(published).includes(replyKeys.publicJwk.x),
  'a published Task must reveal neither the slot nor the key'
);
check(
  'published/tagged',
  (published.meta?.tag ?? []).some(
    (tag) => tag.system === SHL_REQUEST_TAG.system && tag.code === SHL_REQUEST_TAG.code
  ),
  'the tag is how sent requests are searched back out'
);
check(
  'published/correlationPreserved',
  taskCorrelationId(published) === taskCorrelationId(detectionTask),
  'the identifier is the only join between a listed Task and the locally-held reply key'
);
check('published/addresseeKept', published.for?.display === 'Jane Citizen');
check('published/senderKept', published.requester?.display === 'Parkview Medical Centre');

// The invitation copy must be unaffected by any of that.
check(
  'published/invitationCopyKeepsCanonicalFocus',
  detectionTask.focus?.reference === 'http://example.org/Questionnaire/detection|1.2',
  'stripping focus for the server must not strip it from the invitation'
);
check('published/invitationCopyKeepsDescriptor', parseReplyDescriptor(detectionTask) !== undefined);

// ---------------------------------------------------------------------------
// Joining the two halves of "what have I sent?".
// ---------------------------------------------------------------------------

console.log('\nsent-request merge\n');

const localRecord = {
  id: taskCorrelationId(detectionTask)!,
  label: 'Detection contract',
  createdAt: '2026-08-04T02:00:00.000Z',
  link: 'https://links.example.org/view#shlink:/abc',
  reply: { url: descriptor.replyUrl, privateJwk: replyKeys.privateJwk }
};

const foreignTask: Task = {
  resourceType: 'Task',
  id: 'server-99',
  status: 'requested',
  intent: 'order',
  identifier: [{ system: 'urn:ietf:rfc:3986', value: 'urn:uuid:sent-elsewhere' }],
  authoredOn: '2026-08-03T02:00:00.000Z',
  description: 'Complete "Physical Therapy"',
  requester: { display: 'Another Practice' },
  for: { display: 'John Citizen' }
};

const merged = mergeSentRequests([localRecord], [published, foreignTask]);

check('merge/producesOneRowPerRequest', merged.length === 2, `${merged.length} rows`);

const trackedRow = merged.find((row) => row.id === localRecord.id);
check('merge/joinsOnIdentifier', trackedRow?.origin === 'tracked', trackedRow?.origin);
check('merge/trackedRowIsCollectable', trackedRow?.collectable === true);
check('merge/trackedRowKeepsLocalKey', trackedRow?.local?.reply?.privateJwk.d === replyKeys.privateJwk.d);
check('merge/trackedRowGainsServerTask', trackedRow?.serverTask !== undefined);

const foreignRow = merged.find((row) => row.id === 'urn:uuid:sent-elsewhere');
check('merge/foreignRowIsServerOnly', foreignRow?.origin === 'server-only', foreignRow?.origin);
check(
  'merge/foreignRowNotCollectable',
  foreignRow?.collectable === false,
  'offering a Check button that cannot work would be worse than saying why'
);
check(
  'merge/foreignRowExplainsWhy',
  whyNotCollectable(foreignRow!)?.includes('another browser') === true,
  whyNotCollectable(foreignRow!)
);
check(
  'merge/labelRecoveredFromDescription',
  foreignRow?.label === 'Physical Therapy',
  `showing the raw description would read as a form named 'Complete "…"' — got ${foreignRow?.label}`
);
check('merge/newestFirst', merged[0]?.id === localRecord.id, 'sorted by createdAt descending');

// An unpublished local record must still appear, flagged as invisible elsewhere.
const localOnly = mergeSentRequests([localRecord], []);
check('merge/localOnlyRowKept', localOnly[0]?.origin === 'local-only', localOnly[0]?.origin);
check('merge/localOnlyStillCollectable', localOnly[0]?.collectable === true);

// A Task with no identifier cannot be joined to anything, and is dropped rather than shown as a
// mystery row that no action applies to.
const unidentified = mergeSentRequests([], [{ ...foreignTask, identifier: undefined }]);
check('merge/dropsUnidentifiableTasks', unidentified.length === 0);

/*
 * Publishing a Task and offering channel B are different things, and the stored record has to keep them
 * apart. A Task is published for tracking whenever `publishRequestTasks` is on, so `serverTaskUrl` alone
 * does not mean a filler may write there — treating it that way made the UI warn that answers could
 * arrive unreviewed on requests where they could not.
 */
const trackedOnly = mergeSentRequests(
  [{ ...localRecord, serverTaskUrl: 'https://ehr.test/fhir/Task/1', serverReturnOffered: false }],
  []
);
check(
  'merge/publishedIsNotDirectWrite',
  trackedOnly[0]?.local?.serverTaskUrl !== undefined &&
    trackedOnly[0]?.local?.serverReturnOffered === false,
  'a published Task is for tracking; only serverReturnOffered means answers can bypass review'
);

// Expiry removes collectability without removing the row.
const expiredLocal = mergeSentRequests([{ ...localRecord, expiresAt: 1 }], []);
check('merge/expiredIsNotCollectable', expiredLocal[0]?.collectable === false);
check(
  'merge/expiredExplainsWhy',
  whyNotCollectable(expiredLocal[0])?.includes('expired') === true,
  whyNotCollectable(expiredLocal[0])
);

// ---------------------------------------------------------------------------
// Correlating scanned answers back to the request that asked for them.
//
// With answers returning as a link rather than into a slot, the requester no longer learns which
// request was answered from *where* the reply arrived. `Task.identifier` becomes the only thing
// carrying that, so it has to survive the round trip and the join has to be exact.

console.log('\nresponse correlation\n');

const correlationRequest = buildRequestBundle(
  {
    resourceType: 'Questionnaire',
    status: 'active',
    url: 'http://example.org/Questionnaire/correlate',
    title: 'Correlation'
  },
  { requestId: 'urn:uuid:correlate-me', subjectDisplay: 'Jane Citizen' }
);

const correlationLocal: OutstandingRequest = {
  id: taskCorrelationId(correlationRequest.task)!,
  label: 'Correlation',
  questionnaireCanonical: 'http://example.org/Questionnaire/correlate',
  createdAt: '2026-08-04T02:00:00.000Z',
  link: 'https://links.example.org/view#shlink:/abc'
};

// The filler answers, echoing the Task back the way `buildReplyBundle` does.
const correlationReply = buildReplyBundle(
  {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    questionnaire: 'http://example.org/Questionnaire/correlate',
    item: [{ linkId: 'q1', answer: [{ valueBoolean: true }] }]
  },
  { requestTask: correlationRequest.task }
);

const correlationBack = parseResponseBundle(correlationReply.bundle);
check(
  'correlate/joinsOnTaskIdentifier',
  findRequestForTask([correlationLocal], correlationBack.task)?.id === correlationLocal.id,
  'the identifier is the only correlation key that survives a round trip through a third-party app'
);
check('correlate/noTaskNoMatch', findRequestForTask([correlationLocal], undefined) === undefined);
check(
  'correlate/unknownIdNoMatch',
  findRequestForTask([{ ...correlationLocal, id: 'urn:uuid:something-else' }], correlationBack.task) ===
    undefined,
  'a link from a request this browser never sent is reviewable, not matchable'
);

check(
  'correlate/responseCanonicalWins',
  responseCanonical(correlationBack.response, 'http://example.org/Questionnaire/other') ===
    'http://example.org/Questionnaire/correlate'
);
check(
  'correlate/canonicalFallsBackToStored',
  responseCanonical(
    { ...correlationBack.response, questionnaire: undefined },
    correlationLocal.questionnaireCanonical
  ) === correlationLocal.questionnaireCanonical,
  'a filler that dropped the canonical still answered a form whose identity we recorded'
);
check(
  'correlate/canonicalUndefinedWhenNeitherKnows',
  responseCanonical({ ...correlationBack.response, questionnaire: undefined }, undefined) ===
    undefined,
  'not fatal — answers can still be read as a raw table'
);

// ---------------------------------------------------------------------------
// The encrypted reply channel, deferred.
//
// Off by default because the primary return path is a link the filler mints. These assert that
// "off" means the invitation carries nothing at all, not that it carries an unused field.

console.log('\nencrypted reply deferred\n');

check('deferred/flagDefaultsOff', FALLBACK_CONFIG.enableEncryptedReply === false);
check(
  'deferred/needsBlobServer',
  canUseEncryptedReply({ ...FALLBACK_CONFIG, enableEncryptedReply: true }) === false,
  'the fallback names no blob server, so the flag alone can never mint a slot'
);
check(
  'deferred/enabledWithBlobServer',
  canUseEncryptedReply({
    ...FALLBACK_CONFIG,
    enableEncryptedReply: true,
    blobServerUrl: 'https://blobs.test/fhir'
  }) === true,
  'the deferral must be reversible by config alone'
);

const noChannelRequest = buildRequestBundle(
  { resourceType: 'Questionnaire', status: 'active', url: 'http://example.org/Questionnaire/plain' },
  { requestId: 'urn:uuid:no-channel', subjectDisplay: 'Jane Citizen' }
);

check(
  'deferred/requestCarriesNoDescriptor',
  parseReplyDescriptor(noChannelRequest.task) === undefined
);
check('deferred/requestTaskHasNoExtensions', noChannelRequest.task.extension === undefined);
check(
  'deferred/bundleLeaksNoReplyUrl',
  !JSON.stringify(noChannelRequest.bundle).includes('shl-reply-descriptor') &&
    !JSON.stringify(noChannelRequest.bundle).includes('replyUrl'),
  'with the channel off the invitation is just the form'
);
check(
  'deferred/shippedConfigIsBoolean',
  typeof (shippedConfig as Record<string, unknown>).enableEncryptedReply === 'boolean',
  String((shippedConfig as Record<string, unknown>).enableEncryptedReply)
);

// ---------------------------------------------------------------------------
// `sfhl:/` is decode-only: links in the wild keep opening, nothing new is minted.

console.log('\ndecode-only codec\n');

check('bespoke/markedDecodeOnly', bespokeCodec.decodeOnly === true);
check('shl/notDecodeOnly', shlCodec.decodeOnly !== true);

let bespokeEncodingRefused = '';
try {
  encodingCodec({ ...FALLBACK_CONFIG, linkCodec: 'bespoke' } as AppConfig, [bespokeCodec, shlCodec]);
} catch (error) {
  bespokeEncodingRefused = error instanceof Error ? error.message : '';
}
check(
  'bespoke/notSelectableForEncoding',
  bespokeEncodingRefused.includes('decode-only') && bespokeEncodingRefused.includes('linkCodec'),
  bespokeEncodingRefused
);
check(
  'shl/stillSelectableForEncoding',
  encodingCodec(FALLBACK_CONFIG, [bespokeCodec, shlCodec]).id === 'shl'
);
check(
  'bespoke/staleConfigStillValidates',
  isAppConfig({ ...(shippedConfig as object), linkCodec: 'bespoke' }),
  'a config naming a retired codec is stale, not malformed — rejecting it would discard its servers'
);

// ---------------------------------------------------------------------------
// The raw-answers fallback, now that it is pure enough to assert offline.

console.log('\nraw answers fallback\n');

const rawRows = flattenAnswers({
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  item: [
    {
      linkId: 'group',
      text: 'Symptoms',
      item: [
        { linkId: 'pain', text: 'Pain?', answer: [{ valueBoolean: true }] },
        {
          linkId: 'site',
          text: 'Where?',
          answer: [
            {
              valueCoding: { code: '123', display: 'Lower back' },
              item: [{ linkId: 'since', text: 'Since?', answer: [{ valueString: 'March' }] }]
            }
          ]
        }
      ]
    }
  ]
});

check('rawAnswers/walksNestedItems', rawRows.some((row) => row.linkId === 'pain'));
check(
  'rawAnswers/walksAnswerItems',
  rawRows.some((row) => row.linkId === 'since' && row.value === 'March'),
  'an answer can carry its own follow-up items'
);
check(
  'rawAnswers/prefersCodingDisplay',
  rawRows.find((row) => row.linkId === 'site')?.value === 'Lower back',
  'a coded answer rendered as [object Object] is useless to someone deciding whether to accept it'
);
check(
  'rawAnswers/nestedItemIsNotAValue',
  rawRows.find((row) => row.linkId === 'site')?.value !== undefined &&
    !JSON.stringify(rawRows).includes('"value":"[object Object]"')
);

/*
 * An answer is a BackboneElement, so it may carry `id`, `extension` and `modifierExtension` beside
 * its `value[x]`. Picking "whatever field is left over" makes the rendered answer depend on the
 * sending app's JSON key order — which fails intermittently rather than reproducibly, and this is
 * the only rendering available when the Questionnaire cannot be resolved.
 */
const backboneRows = flattenAnswers({
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  item: [
    { linkId: 'lead-id', answer: [{ id: 'a1', valueBoolean: true }] },
    {
      linkId: 'lead-ext',
      answer: [{ extension: [{ url: 'http://x', valueInteger: 3 }], valueInteger: 7 }]
    },
    { linkId: 'trailing-id', answer: [{ valueString: 'yes', id: 'z' }] }
  ]
});

check(
  'rawAnswers/ignoresAnswerId',
  backboneRows.find((row) => row.linkId === 'lead-id')?.value === 'true',
  backboneRows.find((row) => row.linkId === 'lead-id')?.value
);
check(
  'rawAnswers/ignoresAnswerExtension',
  backboneRows.find((row) => row.linkId === 'lead-ext')?.value === '7',
  backboneRows.find((row) => row.linkId === 'lead-ext')?.value
);
check(
  'rawAnswers/keyOrderDoesNotMatter',
  backboneRows.find((row) => row.linkId === 'trailing-id')?.value === 'yes',
  'a foreign app serialising id after value must render the same as one serialising it before'
);
check('rawAnswers/indentsByDepth', rawRows.find((row) => row.linkId === 'pain')?.depth === 1);
check(
  'rawAnswers/emptyResponseYieldsNoRows',
  flattenAnswers({ resourceType: 'QuestionnaireResponse', status: 'completed' }).length === 0
);

// ---------------------------------------------------------------------------
console.log('\n--- SMART App Launch: the token boundary ---');

/*
 * `isLaunchedServer` is the single thing standing between an EHR access token and a server named by
 * whoever authored a downloaded Questionnaire. `resolveDestinations` reads write targets from an
 * `sdc-questionnaire-endpoint` extension and those outrank config, so "is there a session" is not a
 * safe gate — origin is. These are the cases that gate has to get right.
 */
const EHR = 'https://ehr.example.org/fhir';

check('authedFetch/sameOriginMatches', isLaunchedServer(`${EHR}/Patient/123`, EHR));
check(
  'authedFetch/differentPathSameOriginMatches',
  isLaunchedServer('https://ehr.example.org/other/Patient/123', EHR),
  'the server\'s own absolute pagination links are legitimate and must not be refused'
);
check(
  'authedFetch/suffixedHostIsNotAMatch',
  !isLaunchedServer('https://ehr.example.org.attacker.test/fhir/Patient/1', EHR),
  'a prefix test on the base URL would accept this'
);
check('authedFetch/otherHostIsNotAMatch', !isLaunchedServer('https://elsewhere.test/fhir', EHR));
check(
  'authedFetch/schemeMustMatch',
  !isLaunchedServer('http://ehr.example.org/fhir/Patient/1', EHR),
  'origin includes the scheme, so a downgrade to http is a different origin'
);
check(
  'authedFetch/portMustMatch',
  !isLaunchedServer('https://ehr.example.org:8443/fhir', EHR),
  'origin includes the port'
);
check(
  'authedFetch/malformedFailsClosed',
  !isLaunchedServer('not a url', EHR),
  'failing closed costs an unauthenticated request; failing open costs the token'
);

console.log('\n--- SMART App Launch: scopes ---');

const ehrScopes = buildScopes(FALLBACK_CONFIG, false).split(' ');
const standaloneScopes = buildScopes(FALLBACK_CONFIG, true).split(' ');

check('scopes/ehrLaunchKeepsLaunch', ehrScopes.includes('launch'));
check(
  'scopes/standaloneSwapsToLaunchPatient',
  standaloneScopes.includes('launch/patient') && !standaloneScopes.includes('launch'),
  'a bare `launch` means "use the context the launch parameter refers to", and there is none'
);
check(
  'scopes/userContextNotPatient',
  ehrScopes.some((scope) => scope.startsWith('user/')) &&
    !ehrScopes.some((scope) => scope.startsWith('patient/')),
  '/patients and /responses search across the server, which a patient/ grant cannot do'
);
/*
 * The no-update invariant, narrowed rather than dropped.
 *
 * It used to be absolute: no scope carried `u` or `d`. Form data extraction broke half of it honestly
 * — template-based extraction emits `PUT` and `PATCH` entries, because a form recording a resolved
 * allergy is amending something that already exists and there is no create-only way to say that. So
 * `u` is now permitted, on exactly the clinical resource types extraction writes and nothing else.
 *
 * The two halves that still hold are the ones worth protecting. Nothing is ever deleted. And the
 * resources the app *authors* — the response, its Task, its Provenance, and any Patient it registers —
 * are still create-only, which is what `src/fhir/amend.ts` exists to make possible: an amendment is a
 * new resource joined by a Provenance, never an edit of the one that arrived.
 */
const WRITE_BACK_TYPES = [
  'Condition',
  'Observation',
  'AllergyIntolerance',
  'MedicationStatement',
  'Immunization',
  'Procedure',
  'Encounter'
];

check(
  'scopes/noDeleteOnTheEhr',
  !ehrScopes.some((scope) => /^user\/[A-Za-z]+\.[a-z]*d/.test(scope)),
  'the app never deletes anything on the EHR'
);
check(
  'scopes/noUpdateOnResourcesTheAppAuthors',
  !ehrScopes.some((scope) => {
    const match = /^user\/([A-Za-z]+)\.([a-z]*)$/.exec(scope);
    return !!match && match[2].includes('u') && !WRITE_BACK_TYPES.includes(match[1]);
  }),
  'only form data extraction updates anything; responses and Tasks stay create-only'
);
check(
  'scopes/writeBackCanCreateAndUpdate',
  WRITE_BACK_TYPES.every((type) => ehrScopes.includes(`user/${type}.cu`)),
  'template extraction emits POST, PUT and PATCH entries and needs all three'
);
check(
  'scopes/onlineNotOffline',
  ehrScopes.includes('online_access') && !ehrScopes.includes('offline_access'),
  'no backend to hold a refresh token that outlives the session'
);
check(
  'scopes/overrideIsHonoured',
  buildScopes({ ...FALLBACK_CONFIG, smartScopes: 'launch openid' }, false) === 'launch openid'
);

/*
 * What a client *registration* must allow, which is not what any one launch requests. `launch` and
 * `launch/patient` never appear together in a single authorize call, so a registration copied from an
 * observed EHR launch is missing the standalone half — and fails only when somebody opens `/launch`
 * directly, which is exactly the sort of gap that reaches production.
 */
const registration = registrationScopes(FALLBACK_CONFIG);

check(
  'scopes/registrationCoversBothLaunchPatterns',
  registration.includes('launch') && registration.includes('launch/patient'),
  'neither request names both, but a registration allowing only one half-works'
);
check(
  'scopes/registrationIsASupersetOfEveryLaunch',
  [...ehrScopes, ...buildScopes(FALLBACK_CONFIG, true).split(' ')].every((scope) =>
    registration.includes(scope)
  )
);
check(
  'scopes/registrationHasNoDuplicates',
  new Set(registration).size === registration.length,
  'it is rendered for a human to copy, and a repeated entry reads as a mistake'
);
check(
  'scopes/registrationHonoursAnOverride',
  registrationScopes({ ...FALLBACK_CONFIG, smartScopes: 'openid fhirUser' }).join(' ') ===
    'openid fhirUser launch/patient',
  'a deployment that narrowed its scopes must not be shown the defaults'
);

check(
  'scopes/prePopulateOffIsByteIdentical',
  buildScopes({ ...FALLBACK_CONFIG, enablePrePopulate: false }, false) === DEFAULT_SMART_SCOPES,
  'turning the feature off must leave the consent screen exactly as it was'
);
check(
  'scopes/prePopulateMergesWithExtraction',
  buildScopes({ ...FALLBACK_CONFIG, enablePrePopulate: true }, false).split(' ').filter(
    (scope) => scope.startsWith('user/Condition.')
  ).join(' ') === 'user/Condition.crus',
  'extraction wants c+u and population wants r+s on the same type; one scope, asked once'
);
check(
  'scopes/prePopulateAddsUngrantedReads',
  buildScopes({ ...FALLBACK_CONFIG, enablePrePopulate: true }, false).includes(
    'user/MedicationRequest.rs'
  ),
  'types the catalogue queries but the app never wrote'
);
check(
  'scopes/smartScopesStillWinsOverPrePopulate',
  buildScopes(
    { ...FALLBACK_CONFIG, enablePrePopulate: true, smartScopes: 'launch openid' },
    false
  ) === 'launch openid',
  'an explicit list is a statement, not a starting point'
);
check(
  'scopes/mergePreservesOrderAndPassesNonResourceScopes',
  mergePermissions(['launch', 'user/Condition.cu', 'openid', 'user/Condition.rs']).join(' ') ===
    'launch user/Condition.crus openid'
);
check(
  'scopes/mergeKeepsWildcardsAsWildcards',
  mergePermissions(['user/*.*', 'user/*.rs']).join(' ') === 'user/*.*',
  'spelling a wildcard out as letters would be a different string, and missingScopes compares strings'
);
check(
  'scopes/prePopulateScopesAreRecognised',
  isPrePopulateScope('user/Condition.crus') && isPrePopulateScope('user/MedicationRequest.rs')
);
check(
  'scopes/prePopulateAndWriteBackOverlapOnMergedScopes',
  isPrePopulateScope('user/Condition.crus') && isWriteBackScope('user/Condition.crus'),
  'one refused scope costs both features, and the banner must be free to say so twice'
);
check(
  'scopes/coreScopesAreNeitherFeature',
  !isPrePopulateScope('user/Patient.crs') &&
    !isPrePopulateScope('launch') &&
    !isWriteBackScope('user/Patient.crs'),
  'losing the patient picker is not losing a feature, and must not be reported as one'
);

check(
  'scopes/writeBackScopesAreRecognised',
  isWriteBackScope('user/Condition.cu') && isWriteBackScope('user/Encounter.cu')
);
check(
  'scopes/readOnlyScopesAreNotWriteBack',
  !isWriteBackScope('user/Patient.crs') &&
    !isWriteBackScope('user/Provenance.cr') &&
    !isWriteBackScope('launch') &&
    !isWriteBackScope('openid'),
  'the banner tells a user which half of a narrowed grant they lost, so this must not over-match'
);

/*
 * A server may grant less than was asked for without erroring at all. The banner exists because that
 * is silent until a write is refused mid-consultation.
 */
check(
  'scopes/missingIsEmptyWhenFullyGranted',
  missingScopes('launch openid user/Condition.cu', 'launch openid user/Condition.cu').length === 0
);
check(
  'scopes/missingReportsWhatWasNarrowed',
  missingScopes('launch openid user/Condition.cu', 'launch openid').join(' ') === 'user/Condition.cu'
);
check(
  'scopes/missingIsSilentWhenNothingWasEnumerated',
  missingScopes('launch openid user/Condition.cu', '').length === 0,
  'an empty grant means the server declined to enumerate, not that it granted nothing'
);
check(
  'scopes/missingIgnoresExtrasTheServerAdded',
  missingScopes('launch', 'launch openid offline_access').length === 0,
  'a server granting more than was asked for is not a problem to report'
);

console.log('\n--- SMART App Launch: config guards ---');

check(
  'smartLaunch/offByDefault',
  !FALLBACK_CONFIG.enableSmartLaunch && !canUseSmartLaunch(FALLBACK_CONFIG)
);
check(
  'smartLaunch/flagAloneIsNotEnough',
  !canUseSmartLaunch({ ...FALLBACK_CONFIG, enableSmartLaunch: true }),
  'a config that failed to load must not be able to start a flow, whatever the flag says'
);
check(
  'smartLaunch/needsBothIssuerAndClientId',
  !canUseSmartLaunch({
    ...FALLBACK_CONFIG,
    enableSmartLaunch: true,
    smartIssuerUrl: 'https://ehr.example.org/fhir'
  }) &&
    canUseSmartLaunch({
      ...FALLBACK_CONFIG,
      enableSmartLaunch: true,
      smartIssuerUrl: 'https://ehr.example.org/fhir',
      smartClientId: 'an-app'
    })
);

/*
 * The launch outranks configuration, but not a Questionnaire that names its own endpoint — that is
 * the form's author saying where its answers belong, and it was true before launches existed.
 */
const launchedSession = { serverUrl: EHR } as unknown as Parameters<
  typeof resolveDestinations
>[0]['session'];

check(
  'smartLaunch/launchOutranksConfig',
  resolveDestinations({
    responseServerUrl: 'https://configured.test/fhir',
    session: launchedSession
  })[0] === EHR
);
check(
  'smartLaunch/questionnaireEndpointOutranksLaunch',
  resolveDestinations({
    questionnaire: declareResponseEndpoint(detectionQuestionnaire, 'https://declared.test/fhir'),
    responseServerUrl: 'https://configured.test/fhir',
    session: launchedSession
  })[0] === 'https://declared.test/fhir'
);

console.log('\n--- Form data extraction ---');

/*
 * Extraction is the one part of the app that reads a form's *authoring* rather than its answers, so
 * the checks worth having offline are about classification and about the two transformations this app
 * adds on top of the engine. The engine itself is `@aehrc/sdc-template-extract`, which has its own
 * suite in the monorepo; re-testing it here would be duplicating someone else's work.
 */

check('extract/templateFormIsRecognised', canTemplateExtract(QSepsisRisk));
check(
  'extract/formWithNoExtractionIsNotRecognised',
  !canTemplateExtract(detectionQuestionnaire),
  'most forms declare no extraction, and the panel must be absent rather than empty for those'
);
check('extract/undefinedFormIsNotRecognised', !canTemplateExtract(undefined));

const sepsisExtraction = await templateExtract(QRSepsisRisk, QSepsisRisk);

check(
  'extract/producesATransactionBundle',
  sepsisExtraction.bundle.resourceType === 'Bundle' && sepsisExtraction.bundle.type === 'transaction',
  'the write posts this to the server base, which only accepts a transaction or a batch'
);
check(
  'extract/producesEntries',
  (sepsisExtraction.bundle.entry ?? []).length > 0
);

const sepsisRows = describeEntries(sepsisExtraction.bundle);

check(
  'extract/everyRowIsDescribed',
  sepsisRows.length > 0 &&
    sepsisRows.every((row) => row.display.trim() !== '' && row.resourceType !== 'Unknown'),
  'a row a clinician cannot read is a row they cannot make a decision about'
);
check(
  'extract/everyRowIsNewOrUpdate',
  sepsisRows.every((row) => row.method === 'new' || row.method === 'update')
);
check(
  'extract/noRowFallsBackToItsBareType',
  sepsisRows.every((row) => row.display !== row.resourceType),
  'this form emits ServiceRequests, and two rows both reading "ServiceRequest" are two rows nobody can choose between'
);

/*
 * FHIRPatch entries are the case the per-entry UI has to be honest about: one checkbox standing for
 * several operations. The count is what the panel says out loud, so it has to be there.
 */
const patchExtraction = await templateExtract(
  QRMedicalHistoryCurrentProblems,
  QMedicalHistoryCurrentProblemsWithPatch
);
const patchRows = describeEntries(patchExtraction.bundle);

check(
  'extract/patchEntriesReportTheirOperationCount',
  patchRows.some((row) => (row.patchOperationCount ?? 0) > 0),
  'the panel promises "n changes, written together or not at all" and needs n'
);
check(
  'extract/patchEntriesAreUpdates',
  patchRows
    .filter((row) => row.patchOperationCount !== undefined)
    .every((row) => row.method === 'update' && row.target !== undefined),
  'a patch changes something that already exists, and the reviewer should see what'
);

// --- filterBundle -----------------------------------------------------------

const firstOnly = filterBundle(sepsisExtraction.bundle, new Set([0]));

check(
  'extract/filterKeepsTransactionType',
  firstOnly.type === 'transaction' && (firstOnly.entry ?? []).length === 1
);
check(
  'extract/filterKeepsTheGeneratedTag',
  JSON.stringify(firstOnly.meta) === JSON.stringify(sepsisExtraction.bundle.meta),
  'the engine tags what it generated, and an auditor should still see that on what was written'
);
check(
  'extract/filterOfNothingIsEmpty',
  (filterBundle(sepsisExtraction.bundle, new Set()).entry ?? []).length === 0
);
check(
  'extract/filterPreservesBundleOrder',
  JSON.stringify(filterBundle(sepsisExtraction.bundle, new Set([1, 0])).entry) ===
    JSON.stringify((sepsisExtraction.bundle.entry ?? []).slice(0, 2)),
  'template extraction can emit a POST that a later PATCH targets; tick order must not reorder them'
);

// --- retargetSubject --------------------------------------------------------

/*
 * The safety net for the one thing that has no counterpart in smart-forms: answers arriving from an
 * app that names the patient in its own terms. See `src/fhir/extract.ts`.
 */
const strayBundle: Bundle = {
  resourceType: 'Bundle',
  type: 'transaction',
  entry: [
    {
      resource: {
        resourceType: 'Condition',
        subject: { reference: 'Patient/filler-local-key', display: 'Their name for them' }
      },
      request: { method: 'POST', url: 'Condition' }
    },
    {
      resource: {
        resourceType: 'Observation',
        status: 'final',
        code: { text: 'unrelated' },
        subject: { reference: 'Patient/somebody-else' },
        performer: [{ reference: 'Practitioner/filler-local-key' }]
      },
      request: { method: 'POST', url: 'Observation' }
    }
  ]
};

const retargeted = retargetSubject(
  strayBundle,
  { ...QRSepsisRisk, subject: { reference: 'Patient/999', display: 'Chosen Patient' } },
  'Patient/filler-local-key'
);
const retargetedEntries = retargeted.entry ?? [];

check(
  'extract/retargetRewritesTheOriginalSubject',
  JSON.stringify((retargetedEntries[0]?.resource as { subject?: unknown })?.subject) ===
    JSON.stringify({ reference: 'Patient/999', display: 'Chosen Patient' }),
  'a Condition filed against the filler\'s own key is the failure reconciliation exists to prevent'
);
check(
  'extract/retargetLeavesOtherSubjectsAlone',
  (retargetedEntries[1]?.resource as { subject?: { reference?: string } })?.subject?.reference ===
    'Patient/somebody-else'
);
check(
  'extract/retargetIgnoresNonSubjectSlots',
  JSON.stringify((retargetedEntries[1]?.resource as { performer?: unknown })?.performer) ===
    JSON.stringify([{ reference: 'Practitioner/filler-local-key' }]),
  'the same string in a performer is a different claim and is not ours to rewrite'
);
check(
  'extract/retargetIsANoOpWithoutAnOriginal',
  retargetSubject(strayBundle, QRSepsisRisk, undefined) === strayBundle
);

check(
  'extract/unknownResourceStillReads',
  describeResource(undefined) === 'Unknown resource'
);

/* ------------------------------------------------------------------ pre-population */

console.log('\n--- Pre-population ---');

const populatableForm: Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  url: 'http://example.org/Questionnaire/populatable',
  version: '1.0.0',
  extension: [
    {
      url: 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-launchContext',
      extension: [
        { url: 'name', valueCoding: { code: 'patient' } },
        { url: 'type', valueCode: 'Patient' }
      ]
    }
  ],
  item: [{ linkId: 'name', type: 'string', text: 'Name' }]
};

const plainForm: Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  url: 'http://example.org/Questionnaire/plain',
  version: '1.0.0',
  item: [{ linkId: 'name', type: 'string', text: 'Name' }]
};

check(
  'prePopulate/declaredFormIsRecognised',
  questionnaireDeclaresPopulation(populatableForm)
);
check(
  'prePopulate/formWithNoMachineryIsNot',
  !questionnaireDeclaresPopulation(plainForm) && !questionnaireDeclaresPopulation(undefined),
  '26 of the 138 catalogue forms declare nothing, and the toggle must be absent rather than inert'
);
check(
  'prePopulate/itemLevelExpressionCounts',
  questionnaireDeclaresPopulation({
    ...plainForm,
    item: [
      {
        linkId: 'name',
        type: 'string',
        extension: [
          {
            url: 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-initialExpression',
            valueExpression: { language: 'text/fhirpath', expression: "%patient.name.given.first()" }
          }
        ]
      }
    ]
  }),
  'the machinery can be entirely item-level, with nothing at the root to find'
);

/*
 * A populated response with a repeating group, which is the shape that decided the whole design:
 * `Questionnaire.item.initial` cannot express two instances, and this can.
 */
const populatedSeed: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  status: 'in-progress',
  questionnaire: 'http://example.org/Questionnaire/populatable|1.0.0',
  item: [
    { linkId: 'name', text: 'Name', answer: [{ valueString: 'Jane Citizen' }] },
    {
      linkId: 'problems',
      text: 'Problems',
      item: [{ linkId: 'condition', text: 'Condition', answer: [{ valueString: 'Asthma' }] }]
    },
    {
      linkId: 'problems',
      text: 'Problems',
      item: [{ linkId: 'condition', text: 'Condition', answer: [{ valueString: 'Eczema' }] }]
    }
  ]
};

const seedRows = populatedRows(populatedSeed);
check('prePopulate/rowsFlattenEveryAnswer', seedRows.length === 3);
check(
  'prePopulate/repeatedGroupsGetDistinctPaths',
  new Set(seedRows.map((row) => row.path)).size === seedRows.length,
  'a repeating group repeats its children linkIds, so linkId alone cannot key a selection'
);
check(
  'prePopulate/repeatedGroupsAreNumberedForTheReader',
  seedRows[1].groups.join('') === 'Problems 1' && seedRows[2].groups.join('') === 'Problems 2',
  'six rows labelled "Condition" are six rows nobody can choose between'
);
check(
  'prePopulate/singleGroupsAreNotNumbered',
  populatedRows({
    ...populatedSeed,
    item: [populatedSeed.item![1]]
  })[0].groups.join('') === 'Problems',
  '"Problems 1" reads as a distinction when there is nothing to distinguish it from'
);

const keptOne = pruneAnswers(
  populatedSeed,
  new Set(seedRows.filter((row) => row.value !== 'Eczema').map((row) => row.path))
);
check('prePopulate/pruneDropsUntickedAnswers', populatedRows(keptOne).length === 2);
check(
  'prePopulate/pruneDropsTheEmptiedGroup',
  keptOne.item?.filter((item) => item.linkId === 'problems').length === 1,
  'an item present but empty reads to the filler as a question already visited and left blank'
);
check(
  'prePopulate/pruneDoesNotMutateItsInput',
  populatedRows(populatedSeed).length === 3,
  'RequestForm holds this as query data; a mutation would prune it permanently on the first untick'
);
check(
  'prePopulate/pruningEverythingLeavesNoItems',
  pruneAnswers(populatedSeed, new Set()).item === undefined
);

/*
 * The discriminator. Every assertion the old absence-based rule justified must still hold, which is
 * the contract this change put at risk — see `isRequestBundle`.
 */
const seededRequest = buildRequestBundle(populatableForm, {
  requestId: 'seeded',
  subjectReference: 'Patient/123',
  subjectDisplay: 'Jane Citizen',
  prePopulated: populatedSeed
});
const plainRequest = buildRequestBundle(populatableForm, { requestId: 'plain' });

check('prePopulate/plainRequestStillReadsAsARequest', isRequestBundle(plainRequest.bundle));
check(
  'prePopulate/seededRequestReadsAsARequest',
  isRequestBundle(seededRequest.bundle),
  'the case the old rule got wrong, and the reason it had to change'
);
check(
  'prePopulate/answersFromASeededRequestAreNotARequest',
  !isRequestBundle(
    buildResponseBundle(
      { ...populatedSeed, status: 'completed' },
      seededRequest.task
    ).bundle
  ),
  'the regression the new rule risks: a returned response must never route to the form filler'
);
check(
  'prePopulate/anEchoedFormWithFinishedAnswersIsNotARequest',
  !isRequestBundle({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: populatableForm },
      { resource: { ...populatedSeed, status: 'completed' } }
    ]
  }),
  'the protection the old absence rule gave by accident, kept here by inspection'
);
check(
  'prePopulate/amendedAnswersAreNotARequest',
  !isRequestBundle({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: populatableForm }, { resource: { ...populatedSeed, status: 'amended' } }]
  })
);

const seededPayload = parseRequestBundle(seededRequest.bundle);
check('prePopulate/parseReturnsTheSeed', seededPayload.prePopulated !== undefined);
check(
  'prePopulate/parseOfAPlainRequestHasNoSeed',
  parseRequestBundle(plainRequest.bundle).prePopulated === undefined
);
check(
  'prePopulate/taskDeclaresTheSeed',
  seededRequest.task.input?.some((input) => input.valueReference?.reference?.startsWith('urn:uuid:')) ===
    true,
  'declared rather than merely present, so a reader need not infer it from the Bundle'
);
check(
  'prePopulate/seedIsInProgress',
  seededPayload.prePopulated?.status === 'in-progress'
);
check(
  'prePopulate/seedCarriesTheSubject',
  seededPayload.prePopulated?.subject?.reference === 'Patient/123'
);
check(
  'prePopulate/seedCarriesNoAuthorship',
  seededPayload.prePopulated?.author === undefined &&
    seededPayload.prePopulated?.authored === undefined,
  'an author naming the practitioner would land on the answers the patient returns'
);
check(
  'prePopulate/seedCarriesNoSecurityLabel',
  seededPayload.prePopulated?.meta?.security === undefined,
  'a seed is nobody assertion yet; PATAST is applied on the return leg, to answers a patient saw'
);
check(
  'prePopulate/seedForAnotherFormIsDropped',
  parseRequestBundle({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: populatableForm },
      {
        resource: {
          ...populatedSeed,
          questionnaire: 'http://example.org/Questionnaire/somethingelse|1.0.0'
        }
      },
      { resource: seededRequest.task }
    ]
  }).prePopulated === undefined,
  'colliding linkIds would put one form answers against another form questions'
);
check(
  'prePopulate/aFormWithNoCanonicalStillParses',
  parseRequestBundle({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: { ...populatableForm, url: undefined } },
      { resource: { ...populatedSeed, questionnaire: undefined } },
      { resource: { resourceType: 'Task', status: 'requested', intent: 'order' } as Task }
    ]
  }) !== undefined,
  'legal FHIR that already opens today; a seed must not be able to make it throw'
);
check(
  'prePopulate/publishedTaskDropsTheSeedReference',
  (asPublishedTask(seededRequest.task).input ?? []).every(
    (input) => input.valueReference === undefined
  ),
  'the seed lives inside the payload, so its reference resolves to nothing on a shared server'
);
check(
  'prePopulate/publishedTaskKeepsItsCorrelationIdentifier',
  asPublishedTask(seededRequest.task).identifier?.[0].value === 'urn:uuid:seeded',
  'also a urn:uuid, and the one thing that must survive — it is how answers find their request'
);
check(
  'prePopulate/publishedTaskKeepsTheCanonical',
  asPublishedTask(seededRequest.task).input?.some(
    (input) => input.valueCanonical === 'http://example.org/Questionnaire/populatable|1.0.0'
  ) === true,
  'a canonical names a Questionnaire by URL and resolves anywhere; only the urn:uuid does not'
);
check(
  'prePopulate/publishedTaskCarriesNoAnswers',
  !JSON.stringify(asPublishedTask(seededRequest.task)).includes('Asthma'),
  'the tracking Task goes to a shared server and must never carry chart content'
);

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
