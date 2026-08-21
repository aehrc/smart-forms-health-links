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
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { QRMedicalHistoryCurrentProblems } from "../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRMedicalHistoryCurrentProblems";
import { QRRegularMedications } from "../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRRegularMedications";
import { QRSepsisRisk } from "../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRSepsisRisk";
import { JOSE_CONTENT_TYPE, inMemoryBlobStore } from "../src/fhir/blobStore";
import {
  SHL_REQUEST_TAG,
  asPublishedTask,
  declareResponseEndpoint,
  declaredEndpoints,
  referenceResolves,
  resolveDestinations,
  submitResponse,
} from "../src/fhir/submit";
import { flattenAnswers } from "../src/lib/answerRows";
import {
  FALLBACK_CONFIG,
  canUseEncryptedReply,
  isAppConfig,
  type AppConfig,
} from "../src/lib/config";
import { bespokeCodec } from "../src/link/bespokeCodec";
import {
  PasscodeRequiredError,
  bundleResponse,
  encodingCodec,
  extractFragment,
  responseFromBundle,
} from "../src/link/codec";
import { shlCodec } from "../src/link/shlCodec";
import { chooseErrorCorrectionLevel } from "../src/link/qrCapacity";
import {
  decodeUtf8,
  encodeUtf8,
  fromBase64Url,
  toBase64Url,
} from "../src/link/binary";
import {
  decryptJwe,
  encryptJwe,
  generateKey,
  keyToBase64Url,
} from "../src/link/jwe";
import {
  decryptReplyJwe,
  encryptReplyJwe,
  generateReplyKeyPair,
  looksLikeReplyJwe,
} from "../src/link/replyCrypto";
import { replySlotPlaceholder } from "../src/link/replySlot";
import {
  REPLY_DESCRIPTOR_EXTENSION,
  buildReplyDescriptorExtension,
  buildServerTaskUrlExtension,
  isReplyDescriptorExpired,
  parseReplyDescriptor,
  parseServerTaskUrl,
} from "../src/link/replyDescriptor";
import {
  buildReplyBundle,
  buildRequestBundle,
  isRequestBundle,
  parseResponseBundle,
  responseCanonical,
  taskCorrelationId,
} from "../src/link/exchange";
import {
  findRequestForTask,
  mergeSentRequests,
  whyNotCollectable,
} from "../src/lib/sentRequests";

import type { OutstandingRequest } from "../src/lib/requestStore";
import type {
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

const BASE_URL = "https://links.example.org";

const FIXTURES = [
  { name: "QRSepsisRisk", response: QRSepsisRisk },
  { name: "QRRegularMedications", response: QRRegularMedications },
  {
    name: "QRMedicalHistoryCurrentProblems",
    response: QRMedicalHistoryCurrentProblems,
  },
];

let failures = 0;
let total = 0;

/**
 * Report every assertion, pass or fail. A silently-skipped check is indistinguishable from a
 * passing one, so the count is part of the result.
 */
function check(name: string, condition: boolean, detail = "") {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

console.log("link codec round-trip\n");
console.log(
  "fixture                            raw   link   QR level  round-trip",
);

for (const { name, response } of FIXTURES) {
  // A link is only openable if the response names its Questionnaire.
  const withCanonical = response.questionnaire
    ? response
    : { ...response, questionnaire: "http://example.org/Questionnaire/test" };

  const link = await bespokeCodec.encode(
    { bundle: bundleResponse(withCanonical), label: name },
    { baseUrl: BASE_URL },
  );

  const decoded = await bespokeCodec.decode(link);
  const decodedResponse = responseFromBundle(decoded.bundle);

  const rawBytes = Buffer.byteLength(JSON.stringify(withCanonical));
  const linkBytes = Buffer.byteLength(link);
  const level = chooseErrorCorrectionLevel(link);

  const identical =
    JSON.stringify(decodedResponse) === JSON.stringify(withCanonical) &&
    decoded.label === name;

  console.log(
    `${name.padEnd(34)}${String(rawBytes).padStart(5)}${String(linkBytes).padStart(7)}` +
      `${(level ?? "TOO BIG").padStart(10)}  ${identical ? "ok" : "MISMATCH"}`,
  );

  check(name, identical);
  check(name, link.startsWith(`${BASE_URL}/view#sfhl:/`));
  check(name, level !== null);
}

// Codec discrimination: the bespoke codec must not claim SHL links, and vice versa.
check(
  "canDecode/shlink",
  !bespokeCodec.canDecode("https://viewer.example.org#shlink:/eyJ1cmwiOiJ4In0"),
);
check(
  "canDecode/garbage",
  !bespokeCodec.canDecode("https://example.org/nothing"),
);
check("canDecode/bare", bespokeCodec.canDecode("sfhl:/abc"));

// Fragment extraction across the shapes a scanner can hand back.
check(
  "extract/url",
  extractFragment("https://a.org/view#sfhl:/xyz") === "sfhl:/xyz",
  "",
);
check("extract/hash", extractFragment("#sfhl:/xyz") === "sfhl:/xyz", "");
check("extract/bare", extractFragment("sfhl:/xyz") === "sfhl:/xyz", "");
check("extract/plainUrl", extractFragment("https://a.org/view") === "", "");

// Corrupt payloads must fail loudly rather than render a half-decoded form.
for (const [label, bad] of [
  ["truncated", "sfhl:/AAAA"],
  ["empty", "sfhl:/"],
  ["not-base64", "sfhl:/!!!!"],
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

console.log("\nconfig\n");

// Resolved from cwd, not import.meta.url: this script is bundled into node_modules/.cache first, so
// a module-relative path would look there. npm scripts run from the package root.
const shippedConfig: unknown = JSON.parse(
  readFileSync(`${process.cwd()}/public/config.json`, "utf8"),
);

check(
  "config/isValid",
  isAppConfig(shippedConfig),
  JSON.stringify(shippedConfig),
);

if (isAppConfig(shippedConfig)) {
  // The forms server is a read-only catalogue; writing there is the bug this guards against.
  check(
    "config/writeTargetsAreNotTheFormsServer",
    shippedConfig.responseServerUrl !== shippedConfig.formsServerUrl &&
      shippedConfig.blobServerUrl !== shippedConfig.formsServerUrl,
    `responses -> ${shippedConfig.responseServerUrl}, blobs -> ${shippedConfig.blobServerUrl}`,
  );

  // The shipped config is the demo: `npm install && npm run dev` has to complete the whole round trip
  // with nothing else configured. Both write targets are required for that — without a blob host no
  // link can be minted at all, and without an EHR reviewed answers have nowhere to land. This is the
  // opposite requirement to FALLBACK_CONFIG below, and deliberately so: what ships in the repo is a
  // chosen sandbox, whereas the fallback is a config that failed to load and must guess nothing.
  check(
    "config/shippedConfigCompletesTheLoop",
    typeof shippedConfig.responseServerUrl === "string" &&
      typeof shippedConfig.blobServerUrl === "string",
    "a clone with no setup must be able to mint a link and save a reviewed response",
  );
}

// The fallback used when config.json is missing or malformed must NOT name a write target: silently
// writing to some server because config failed to load is worse than refusing.
check(
  "config/fallbackHasNoWriteTargets",
  FALLBACK_CONFIG.responseServerUrl === null &&
    FALLBACK_CONFIG.blobServerUrl === null,
);

// ---------------------------------------------------------------------------
// JWE (alg=dir, enc=A256GCM) — the crypto layer SMART Health Links requires.
// ---------------------------------------------------------------------------

console.log("\nJWE\n");

const jweKey = generateKey();
check("jwe/keyLength", jweKey.length === 32, `${jweKey.length} bytes`);
check("jwe/keyBase64UrlIs43Chars", keyToBase64Url(jweKey).length === 43);

const jwePlaintext = encodeUtf8(
  JSON.stringify({ hello: "world", nested: [1, 2, 3] }),
);
const compact = await encryptJwe(jwePlaintext, jweKey);
const jweSegments = compact.split(".");

check("jwe/fiveSegments", jweSegments.length === 5, `${jweSegments.length}`);
check("jwe/encryptedKeySegmentEmpty", jweSegments[1] === "");
check(
  "jwe/protectedHeader",
  decodeUtf8(fromBase64Url(jweSegments[0])) === '{"alg":"dir","enc":"A256GCM"}',
  decodeUtf8(fromBase64Url(jweSegments[0])),
);

const jweDecrypted = await decryptJwe(compact, jweKey);
check("jwe/roundTrip", decodeUtf8(jweDecrypted) === decodeUtf8(jwePlaintext));

// A wrong key must fail, not return garbage — this is the whole security property.
let wrongKeyRejected = false;
try {
  await decryptJwe(compact, generateKey());
} catch {
  wrongKeyRejected = true;
}
check("jwe/wrongKeyRejected", wrongKeyRejected);

// Tampering with the ciphertext must fail GCM authentication.
let tamperRejected = false;
try {
  const bytes = fromBase64Url(jweSegments[3]);
  bytes[0] ^= 0xff;
  await decryptJwe(
    [
      jweSegments[0],
      "",
      jweSegments[2],
      toBase64Url(bytes),
      jweSegments[4],
    ].join("."),
    jweKey,
  );
} catch {
  tamperRejected = true;
}
check("jwe/tamperRejected", tamperRejected);

// ---------------------------------------------------------------------------
// SHL codec against an in-memory blob store — no network, no hosting.
// ---------------------------------------------------------------------------

console.log("\nSMART Health Links\n");

const store = inMemoryBlobStore();

// The codec fetches its payload by URL; serve the in-memory store through a fetch shim.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const stored = store.get(url);
  if (stored) {
    return new Response(stored, { status: 200 });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const shlBundle = bundleResponse({
  ...QRMedicalHistoryCurrentProblems,
  questionnaire: "http://example.org/Questionnaire/test",
});

const shlLink = await shlCodec.encode(
  { bundle: shlBundle, label: "Medical History" },
  { baseUrl: BASE_URL, blobStore: store },
);

check(
  "shl/linkShape",
  shlLink.startsWith(`${BASE_URL}/view#shlink:/`),
  shlLink.slice(0, 60),
);
check(
  "shl/linkIsTiny",
  Buffer.byteLength(shlLink) < 400,
  `${Buffer.byteLength(shlLink)} bytes`,
);
check(
  "shl/linkFitsQr",
  chooseErrorCorrectionLevel(shlLink) !== null,
  `level ${chooseErrorCorrectionLevel(shlLink)}`,
);

const shlPayload = JSON.parse(
  decodeUtf8(
    fromBase64Url(
      shlLink.slice(shlLink.indexOf("shlink:/") + "shlink:/".length),
    ),
  ),
);
check("shl/flagIsU", shlPayload.flag === "U", JSON.stringify(shlPayload.flag));
check("shl/keyIs43Chars", shlPayload.key?.length === 43);
check(
  "shl/hasUrl",
  typeof shlPayload.url === "string" && shlPayload.url.length > 0,
);
check("shl/label", shlPayload.label === "Medical History");

const shlDecoded = await shlCodec.decode(shlLink);
check(
  "shl/roundTrip",
  JSON.stringify(responseFromBundle(shlDecoded.bundle)) ===
    JSON.stringify(responseFromBundle(shlBundle)),
);
check("shl/labelSurvives", shlDecoded.label === "Medical History");

// The hosted blob must be opaque: no plaintext answers recoverable from it.
const hostedBlob = decodeUtf8(store.get(shlPayload.url)!);
check(
  "shl/hostedBlobIsOpaque",
  !hostedBlob.includes("QuestionnaireResponse") &&
    hostedBlob.split(".").length === 5,
  `${hostedBlob.length} bytes of JWE`,
);

// Codec discrimination in both directions.
check("shl/canDecodeShlink", shlCodec.canDecode(shlLink));
check(
  "shl/rejectsBespoke",
  !shlCodec.canDecode("https://a.org/view#sfhl:/abc"),
);
check("bespoke/rejectsShlink", !bespokeCodec.canDecode(shlLink));

// Encoding without a blob store must fail with a useful message rather than a TypeError.
let noStoreRejected = false;
try {
  await shlCodec.encode({ bundle: shlBundle }, { baseUrl: BASE_URL });
} catch (error) {
  noStoreRejected =
    error instanceof Error && error.message.includes("BlobStore");
}
check("shl/requiresBlobStore", noStoreRejected);

// Expiry must be honoured.
const expiredPayload = toBase64Url(
  encodeUtf8(
    JSON.stringify({
      url: "https://x.test/a",
      key: shlPayload.key,
      flag: "U",
      exp: 1,
    }),
  ),
);
let expiryRejected = false;
try {
  await shlCodec.decode(`#shlink:/${expiredPayload}`);
} catch (error) {
  expiryRejected = error instanceof Error && error.message.includes("expired");
}
check("shl/expiredRejected", expiryRejected);

// ---------------------------------------------------------------------------
// Reading a link this app did not write.
//
// The primary return path is now a filler minting its own SMART Health Link and the requester
// scanning it back, so the decode side has to cope with shapes this app would never produce: a bare
// resource where it writes a Bundle, a manifest where it writes a `U` flag, content split across
// files where it writes one. Every assertion here describes a link that is entirely legal and that
// the strict reader rejected or silently truncated.

console.log("\nforeign response links\n");

/** Host a JWE of `content` under `key` and mint the `shlink:` fragment that points at it. */
async function hostShl(
  content: unknown,
  key: Uint8Array,
  extra: Record<string, unknown> = {},
) {
  const url = await store.put(
    encodeUtf8(await encryptJwe(encodeUtf8(JSON.stringify(content)), key)),
    JOSE_CONTENT_TYPE,
  );

  return {
    url,
    link: `#shlink:/${toBase64Url(
      encodeUtf8(
        JSON.stringify({ url, key: keyToBase64Url(key), v: 1, ...extra }),
      ),
    )}`,
  };
}

const foreignKey = generateKey();
const foreignResponse: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: "http://example.org/Questionnaire/test",
  subject: { reference: "Patient/vault-local-42" },
  item: [
    {
      linkId: "q1",
      text: "Any pain?",
      answer: [{ valueString: "Occasionally" }],
    },
  ],
};

// A bare resource, not a Bundle — an entirely ordinary `application/fhir+json` payload.
const bare = await hostShl(foreignResponse, foreignKey, { flag: "U" });
const bareDecoded = await shlCodec.decode(bare.link);
check(
  "foreign/bareResourceNormalised",
  parseResponseBundle(bareDecoded.bundle).response.item?.[0].answer?.[0]
    .valueString === "Occasionally",
  "a filler that parks a QuestionnaireResponse rather than a Bundle has done nothing wrong",
);
check(
  "foreign/bareResourceIsNotARequest",
  !isRequestBundle(bareDecoded.bundle),
  "must route to review, not to the form filler",
);

/*
 * Manifest mode. Serve a POST manifest alongside the blob shim already installed, so the same
 * in-memory store backs both `location` reads and the manifest itself.
 */
let manifestFiles: {
  contentType: string;
  location?: string;
  embedded?: string;
}[] = [];
let manifestPasscode: string | undefined;
let manifestCalls = 0;
let lastManifestBody: Record<string, unknown> = {};
const MANIFEST_URL = "https://manifest.test/shl/abc";

const blobShim = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url === MANIFEST_URL) {
    manifestCalls++;
    lastManifestBody = JSON.parse(String(init?.body ?? "{}"));
    if (
      manifestPasscode !== undefined &&
      lastManifestBody.passcode !== manifestPasscode
    ) {
      return Response.json(
        { remainingAttempts: 2 },
        {
          status: 401,
        },
      );
    }
    return Response.json(
      { files: manifestFiles },
      {
        status: 200,
      },
    );
  }
  return blobShim(input as RequestInfo, init);
}) as typeof fetch;

const manifestLink = `#shlink:/${toBase64Url(
  encodeUtf8(
    JSON.stringify({
      url: MANIFEST_URL,
      key: keyToBase64Url(foreignKey),
      v: 1,
    }),
  ),
)}`;

/** Encrypt `content` under the foreign key and host it, returning just the URL. */
const hostFile = async (content: unknown) =>
  (await hostShl(content, foreignKey)).url;

const foreignProvenance: Provenance = {
  resourceType: "Provenance",
  target: [{ reference: "QuestionnaireResponse/local" }],
  recorded: "2026-01-01T00:00:00Z",
  agent: [{ who: { reference: "Patient/vault-local-42" } }],
};

// The answers in one file, the attribution in another. That is one payload, not a choice.
manifestFiles = [
  {
    contentType: "application/fhir+json",
    location: await hostFile(bundleResponse(foreignResponse)),
  },
  {
    contentType: "application/fhir+json",
    location: await hostFile(foreignProvenance),
  },
];

const mergedFiles = await shlCodec.decode(manifestLink);
const mergedPayload = parseResponseBundle(mergedFiles.bundle);
check(
  "foreign/manifestMergesAllFhirFiles",
  mergedPayload.response !== undefined &&
    mergedPayload.provenance !== undefined,
  "taking only the first file drops the PATAST attribution that makes a reply safe to store",
);

// A file type this app cannot render must be reported, not silently dropped.
manifestFiles = [
  {
    contentType: "application/fhir+json",
    location: await hostFile(bundleResponse(foreignResponse)),
  },
  {
    contentType: "application/smart-health-card",
    location: await hostFile({ vc: {} }),
  },
];
const withCard = await shlCodec.decode(manifestLink);
check(
  "foreign/manifestIgnoresNonFhir",
  parseResponseBundle(withCard.bundle).response !== undefined,
);
check(
  "foreign/manifestWarnsAboutSkipped",
  (withCard.warnings ?? []).some((warning) =>
    warning.includes("smart-health-card"),
  ),
  (withCard.warnings ?? []).join(" | "),
);

// `application/fhir+json; charset=utf-8` is the same content type.
manifestFiles = [
  {
    contentType: "application/fhir+json; charset=utf-8",
    location: await hostFile(bundleResponse(foreignResponse)),
  },
];
check(
  "foreign/manifestToleratesContentTypeParameters",
  parseResponseBundle((await shlCodec.decode(manifestLink)).bundle).response !==
    undefined,
);

// One unreadable file must cost its own content, not the whole link.
const corruptUrl = await store.put(
  encodeUtf8("not.a.valid.jwe.at-all"),
  JOSE_CONTENT_TYPE,
);
manifestFiles = [
  { contentType: "application/fhir+json", location: corruptUrl },
  {
    contentType: "application/fhir+json",
    location: await hostFile(bundleResponse(foreignResponse)),
  },
];
const partialRead = await shlCodec.decode(manifestLink);
check(
  "foreign/manifestSurvivesOneBadFile",
  parseResponseBundle(partialRead.bundle).response !== undefined,
);
check(
  "foreign/manifestWarnsAboutBadFile",
  (partialRead.warnings ?? []).some((warning) =>
    warning.includes("could not be read"),
  ),
  (partialRead.warnings ?? []).join(" | "),
);

// …but a manifest where nothing decoded is a broken link, not an empty one.
manifestFiles = [
  { contentType: "application/fhir+json", location: corruptUrl },
];
let allBadRejected = false;
try {
  await shlCodec.decode(manifestLink);
} catch (error) {
  allBadRejected =
    error instanceof Error && error.message.includes("Nothing in this link");
}
check(
  "foreign/manifestAllBadThrows",
  allBadRejected,
  'reporting "no answers" for a link that failed to decrypt would be a lie',
);

// A request delivered by manifest must still read as a request.
const manifestRequest = buildRequestBundle(
  {
    resourceType: "Questionnaire",
    status: "active",
    url: "http://example.org/Questionnaire/test",
  },
  { requestId: "urn:uuid:manifest-request" },
);
manifestFiles = [
  {
    contentType: "application/fhir+json",
    location: await hostFile(manifestRequest.bundle),
  },
];
check(
  "foreign/manifestRequestStillRoutesAsRequest",
  isRequestBundle((await shlCodec.decode(manifestLink)).bundle),
);

// An embedded file needs no second fetch.
manifestFiles = [
  {
    contentType: "application/fhir+json",
    embedded: await encryptJwe(
      encodeUtf8(JSON.stringify(bundleResponse(foreignResponse))),
      foreignKey,
    ),
  },
];
check(
  "foreign/manifestReadsEmbedded",
  parseResponseBundle((await shlCodec.decode(manifestLink)).bundle).response !==
    undefined,
);

// ---------------------------------------------------------------------------
// Passcodes.

console.log("\npasscode-protected links\n");

manifestPasscode = "letmein";
manifestFiles = [
  {
    contentType: "application/fhir+json",
    location: await hostFile(bundleResponse(foreignResponse)),
  },
];

let passcodeError: unknown;
try {
  await shlCodec.decode(manifestLink, { passcode: "wrong" });
} catch (error) {
  passcodeError = error;
}
check(
  "passcode/manifest401ThrowsTyped",
  passcodeError instanceof PasscodeRequiredError,
);
check(
  "passcode/reportsRemainingAttempts",
  (passcodeError as PasscodeRequiredError)?.remainingAttempts === 2,
);
check(
  "passcode/knowsItWasAttempted",
  (passcodeError as PasscodeRequiredError)?.wasAttempted === true,
);

check(
  "passcode/correctPasscodeSucceeds",
  parseResponseBundle(
    (await shlCodec.decode(manifestLink, { passcode: "letmein" })).bundle,
  ).response !== undefined,
);
check(
  "passcode/reachesTheManifestBody",
  lastManifestBody.passcode === "letmein",
);
check(
  "passcode/recipientOverridable",
  ((await shlCodec.decode(manifestLink, {
    passcode: "letmein",
    recipient: "Someone Else",
  })) && lastManifestBody.recipient === "Someone Else") === true,
);

/*
 * A `P`-flagged link must ask before it knocks. A manifest server may count a passcode-less request
 * as a failed attempt and lock the link permanently, so spending one of a patient's attempts to
 * discover something the payload already states would be inexcusable.
 */
const pFlagLink = `#shlink:/${toBase64Url(
  encodeUtf8(
    JSON.stringify({
      url: MANIFEST_URL,
      key: keyToBase64Url(foreignKey),
      flag: "P",
      v: 1,
    }),
  ),
)}`;

const callsBeforePreempt = manifestCalls;
let preempted: unknown;
try {
  await shlCodec.decode(pFlagLink);
} catch (error) {
  preempted = error;
}
check(
  "passcode/pFlagPreemptsWithoutRequest",
  preempted instanceof PasscodeRequiredError,
);
check(
  "passcode/pFlagKnowsNothingWasTried",
  (preempted as PasscodeRequiredError)?.wasAttempted === false,
);
check(
  "passcode/pFlagCostsNoAttempt",
  manifestCalls === callsBeforePreempt,
  "burning an attempt to learn what the payload already says would be inexcusable",
);
check(
  "passcode/pFlagOpensWhenSupplied",
  parseResponseBundle(
    (await shlCodec.decode(pFlagLink, { passcode: "letmein" })).bundle,
  ).response !== undefined,
);

manifestPasscode = undefined;
globalThis.fetch = realFetch;

// The optional argument must not have disturbed the other codec's narrower signature.
const bespokeWithOptions = await bespokeCodec.encode(
  { bundle: bundleResponse(foreignResponse), label: "unaffected" },
  { baseUrl: BASE_URL },
);
check(
  "passcode/bespokeSignatureUnaffected",
  responseFromBundle(
    (await bespokeCodec.decode(bespokeWithOptions, { passcode: "x" })).bundle,
  ).status === "completed",
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

console.log("\nreply crypto (ECDH-ES + A256GCM)\n");

const nodeB64u = (bytes: Buffer | Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
const nodeFromB64u = (value: string) => Buffer.from(value, "base64url");

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

  return createHash("sha256")
    .update(
      Buffer.concat([
        counter,
        z,
        Buffer.concat([
          lengthPrefixed(Buffer.from("A256GCM", "ascii")),
          lengthPrefixed(Buffer.alloc(0)),
          lengthPrefixed(Buffer.alloc(0)),
          suppPubInfo,
        ]),
      ]),
    )
    .digest();
}

const jwkToPoint = (jwk: { x: string; y: string }) =>
  Buffer.concat([
    Buffer.from([0x04]),
    nodeFromB64u(jwk.x),
    nodeFromB64u(jwk.y),
  ]);

function nodeEncryptReply(
  plaintext: string,
  recipient: { x: string; y: string },
): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const point = ecdh.getPublicKey();
  const epk = {
    kty: "EC",
    crv: "P-256",
    x: nodeB64u(point.subarray(1, 33)),
    y: nodeB64u(point.subarray(33, 65)),
  };
  const cek = nodeConcatKdf(ecdh.computeSecret(jwkToPoint(recipient)));
  const iv = randomBytes(12);
  const header = nodeB64u(
    Buffer.from(JSON.stringify({ alg: "ECDH-ES", enc: "A256GCM", epk })),
  );
  const cipher = createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);

  return [
    header,
    "",
    nodeB64u(iv),
    nodeB64u(ciphertext),
    nodeB64u(cipher.getAuthTag()),
  ].join(".");
}

function nodeDecryptReply(jwe: string, privateJwk: { d: string }): string {
  const [header, encryptedKey, iv, ciphertext, tag] = jwe.split(".");
  if (encryptedKey !== "") {
    throw new Error("expected an empty encrypted-key segment");
  }

  const parsed = JSON.parse(nodeFromB64u(header).toString("utf8"));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(nodeFromB64u(privateJwk.d));
  const cek = nodeConcatKdf(ecdh.computeSecret(jwkToPoint(parsed.epk)));
  const decipher = createDecipheriv("aes-256-gcm", cek, nodeFromB64u(iv));
  decipher.setAAD(Buffer.from(header, "ascii"));
  decipher.setAuthTag(nodeFromB64u(tag));

  return Buffer.concat([
    decipher.update(nodeFromB64u(ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

const replyKeys = await generateReplyKeyPair();
check(
  "reply/publicJwkIsMinimal",
  Object.keys(replyKeys.publicJwk).sort().join(",") === "crv,kty,x,y",
  Object.keys(replyKeys.publicJwk).join(","),
);
check("reply/curveIsP256", replyKeys.publicJwk.crv === "P-256");

const replyMessage = JSON.stringify({
  resourceType: "Bundle",
  type: "collection",
  entry: [],
});
const replyJwe = await encryptReplyJwe(
  encodeUtf8(replyMessage),
  replyKeys.publicJwk,
);
const replySegments = replyJwe.split(".");

check(
  "reply/fiveSegments",
  replySegments.length === 5,
  `${replySegments.length}`,
);
check("reply/encryptedKeySegmentEmpty", replySegments[1] === "");

const replyHeader = JSON.parse(decodeUtf8(fromBase64Url(replySegments[0])));
check(
  "reply/algIsEcdhEs",
  replyHeader.alg === "ECDH-ES",
  String(replyHeader.alg),
);
check(
  "reply/encIsA256Gcm",
  replyHeader.enc === "A256GCM",
  String(replyHeader.enc),
);
check(
  "reply/headerCarriesEphemeralKey",
  replyHeader.epk?.crv === "P-256" && typeof replyHeader.epk?.x === "string",
);
check(
  "reply/headerHasNoPrivateKey",
  replyHeader.epk?.d === undefined,
  "an epk with `d` would publish the sender key",
);
check(
  "reply/noApuApv",
  replyHeader.apu === undefined && replyHeader.apv === undefined,
);

check(
  "reply/roundTrip",
  decodeUtf8(await decryptReplyJwe(replyJwe, replyKeys.privateJwk)) ===
    replyMessage,
);

// The interop assertions that actually matter.
check(
  "reply/interop:oursDecryptedByNode",
  nodeDecryptReply(replyJwe, replyKeys.privateJwk) === replyMessage,
);
check(
  "reply/interop:nodeDecryptedByOurs",
  decodeUtf8(
    await decryptReplyJwe(
      nodeEncryptReply(replyMessage, replyKeys.publicJwk),
      replyKeys.privateJwk,
    ),
  ) === replyMessage,
);

// A key generated the way Platypus generates its practice key must work with our implementation.
const foreignEcdh = createECDH("prime256v1");
foreignEcdh.generateKeys();
const foreignPoint = foreignEcdh.getPublicKey();
const foreignPublic = {
  kty: "EC" as const,
  crv: "P-256" as const,
  x: nodeB64u(foreignPoint.subarray(1, 33)),
  y: nodeB64u(foreignPoint.subarray(33, 65)),
};
const foreignPrivate = {
  ...foreignPublic,
  d: nodeB64u(foreignEcdh.getPrivateKey()),
};
check(
  "reply/interop:foreignKeyPair",
  decodeUtf8(
    await decryptReplyJwe(
      await encryptReplyJwe(encodeUtf8(replyMessage), foreignPublic),
      foreignPrivate,
    ),
  ) === replyMessage,
);

async function replyRejects(
  mutate: (segments: string[]) => string[] | Promise<string[]>,
  key = replyKeys.privateJwk,
) {
  try {
    await decryptReplyJwe((await mutate([...replySegments])).join("."), key);
    return false;
  } catch {
    return true;
  }
}

check(
  "reply/wrongKeyRejected",
  await replyRejects(
    (segments) => segments,
    (await generateReplyKeyPair()).privateJwk,
  ),
);
check(
  "reply/tamperedCiphertextRejected",
  await replyRejects((segments) => {
    const bytes = fromBase64Url(segments[3]);
    bytes[0] ^= 0xff;
    segments[3] = toBase64Url(bytes);
    return segments;
  }),
);
check(
  "reply/tamperedEpkRejected",
  await replyRejects(async (segments) => {
    const header = JSON.parse(decodeUtf8(fromBase64Url(segments[0])));
    header.epk = (await generateReplyKeyPair()).publicJwk;
    segments[0] = toBase64Url(encodeUtf8(JSON.stringify(header)));
    return segments;
  }),
);
// `dir` and `ECDH-ES` must not be interchangeable: accepting a `dir` header here would let anyone who
// has the link's symmetric key read a reply.
check(
  "reply/rejectsDirAlg",
  await replyRejects((segments) => {
    segments[0] = toBase64Url(
      encodeUtf8(JSON.stringify({ alg: "dir", enc: "A256GCM" })),
    );
    return segments;
  }),
);

check("reply/looksLikeReplyJwe:accepts", looksLikeReplyJwe(replyJwe));
check(
  "reply/looksLikeReplyJwe:rejectsPending",
  !looksLikeReplyJwe(replySlotPlaceholder()),
);
// A fixed placeholder makes every slot after the first a byte-identical create, which servers that
// deduplicate reject (HAPI-2840). Uniqueness is what stops the second request ever minted failing.
check(
  "reply/slotPlaceholderIsUnique",
  replySlotPlaceholder() !== replySlotPlaceholder(),
  "identical placeholders collide on servers that deduplicate creates",
);

// ---------------------------------------------------------------------------
// Reply descriptor — build, parse, and tolerance of Platypus's own identifiers.
// ---------------------------------------------------------------------------

console.log("\nreply descriptor\n");

const descriptor = {
  replyUrl: "https://blobs.test/Binary/42",
  replyMethod: "PUT" as const,
  publicJwk: replyKeys.publicJwk,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
};

const descriptorTask: Task = {
  resourceType: "Task",
  status: "requested",
  intent: "order",
  extension: [
    buildReplyDescriptorExtension(descriptor),
    buildServerTaskUrlExtension("https://ehr.test/fhir/Task/7"),
  ],
};

const parsedDescriptor = parseReplyDescriptor(descriptorTask);
check(
  "descriptor/roundTripsUrl",
  parsedDescriptor?.replyUrl === descriptor.replyUrl,
);
check("descriptor/roundTripsMethod", parsedDescriptor?.replyMethod === "PUT");
check(
  "descriptor/roundTripsKey",
  JSON.stringify(parsedDescriptor?.publicJwk) ===
    JSON.stringify(replyKeys.publicJwk),
);
check(
  "descriptor/roundTripsExpiry",
  parsedDescriptor?.expiresAt === descriptor.expiresAt,
);
check(
  "descriptor/serverTaskUrl",
  parseServerTaskUrl(descriptorTask) === "https://ehr.test/fhir/Task/7",
);

// The private key must never end up in a descriptor, however the caller was holding it.
check(
  "descriptor/carriesNoPrivateKey",
  !JSON.stringify(descriptorTask).includes(replyKeys.privateJwk.d),
  "a descriptor holding `d` would let anyone with the link read the reply",
);

// A Platypus-minted descriptor: its extension URL, its `replyPostToken` field name, `valueString` for
// the URL, and no `replyMethod` at all.
const platypusTask: Task = {
  resourceType: "Task",
  status: "requested",
  intent: "order",
  extension: [
    {
      url: "https://platypushealth.app/StructureDefinition/shl-reply-descriptor",
      extension: [
        {
          url: "replyUrl",
          valueString: "https://relay.test/shl/reply-slots/abc",
        },
        { url: "replyPostToken", valueString: "token-xyz" },
        { url: "publicJwk", valueString: JSON.stringify(replyKeys.publicJwk) },
        { url: "expiresAt", valueInteger: 1_893_456_000 },
      ],
    },
    {
      url: "https://platypushealth.app/StructureDefinition/invitation-server-task-url",
      valueString: "https://practice.test/fhir/Task/99",
    },
  ],
};

const parsedPlatypus = parseReplyDescriptor(platypusTask);
check("descriptor/readsPlatypusExtensionUrl", parsedPlatypus !== undefined);
check(
  "descriptor/readsValueStringUrl",
  parsedPlatypus?.replyUrl === "https://relay.test/shl/reply-slots/abc",
);
check(
  "descriptor/readsReplyPostTokenAlias",
  parsedPlatypus?.replyToken === "token-xyz",
);
check(
  "descriptor/inferrsRelayWhenUntyped",
  parsedPlatypus?.replyMethod === "relay-grant",
  "a tokened descriptor with no replyMethod is a relay, and must not be PUT at blindly",
);
check(
  "descriptor/readsPlatypusServerTaskUrl",
  parseServerTaskUrl(platypusTask) === "https://practice.test/fhir/Task/99",
);

// Malformed descriptors degrade to "no reply channel" rather than breaking the receive flow.
const partial: Task = {
  resourceType: "Task",
  status: "requested",
  intent: "order",
  extension: [
    {
      url: REPLY_DESCRIPTOR_EXTENSION,
      extension: [{ url: "replyUrl", valueUrl: "https://blobs.test/Binary/1" }],
    },
  ],
};
check(
  "descriptor/partialIsIgnored",
  parseReplyDescriptor(partial) === undefined,
  "missing publicJwk",
);
check(
  "descriptor/absentIsUndefined",
  parseReplyDescriptor({
    resourceType: "Task",
    status: "requested",
    intent: "order",
  }) === undefined,
);
check(
  "descriptor/badJwkIsIgnored",
  parseReplyDescriptor({
    resourceType: "Task",
    status: "requested",
    intent: "order",
    extension: [
      {
        url: REPLY_DESCRIPTOR_EXTENSION,
        extension: [
          { url: "replyUrl", valueUrl: "https://blobs.test/Binary/1" },
          { url: "publicJwk", valueString: '{"kty":"RSA"}' },
        ],
      },
    ],
  }) === undefined,
  "a non-P-256 key must not be accepted",
);
check(
  "descriptor/expiryHonoured",
  isReplyDescriptorExpired({ ...descriptor, expiresAt: 1 }),
);
check("descriptor/unexpiredIsUsable", !isReplyDescriptorExpired(descriptor));

// ---------------------------------------------------------------------------
// The Platypus detection contract.
//
// Replicated from `apps/mobile/lib/sdc-requested.ts` (`questionnaireRefFromTask`) and
// `apps/mobile/lib/shl-invitation.ts` (`taskTargetsQuestionnaire`) so a change to how our Task names
// its Questionnaire cannot silently stop a third party recognising our invitations. Without this the
// failure mode is invisible from here: the form still opens, it just loses its Task, its addressing and
// every return channel — degrading to a form nobody can send back.
// ---------------------------------------------------------------------------

console.log("\nplatypus detection contract\n");

/** Verbatim port of Platypus's `questionnaireRefFromTask`. */
function questionnaireRefFromTask(task: Task): string | undefined {
  const focus = task.focus?.reference;
  if (focus && /questionnaire/i.test(focus)) return focus;
  if (focus && task.focus?.type === "Questionnaire") return focus;

  for (const input of task.input ?? []) {
    const typeCode = input.type?.coding?.[0]?.code ?? input.type?.text;
    const isQuestionnaire =
      (typeCode && ["questionnaire", "Questionnaire"].includes(typeCode)) ||
      input.valueCanonical != null;
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
    const canonical = ref.split("|", 1)[0];
    return (
      ref === q.url ||
      canonical === q.url ||
      ref === q.id ||
      (q.id != null && ref === `Questionnaire/${q.id}`)
    );
  };

  return (
    matches(questionnaireRefFromTask(task)) || matches(task.focus?.reference)
  );
}

const detectionQuestionnaire: Questionnaire = {
  resourceType: "Questionnaire",
  id: "detection-test",
  url: "http://example.org/Questionnaire/detection",
  version: "1.2",
  status: "active",
  title: "Detection contract",
  item: [{ linkId: "q1", type: "string", text: "Anything" }],
};

const { bundle: detectionBundle, task: detectionTask } = buildRequestBundle(
  detectionQuestionnaire,
  {
    subjectReference: "Patient/123",
    subjectDisplay: "Jane Citizen",
    requesterDisplay: "Parkview Medical Centre",
    replyDescriptor: descriptor,
  },
);

check(
  "detection/taskIsRequested",
  detectionTask.status === "requested",
  detectionTask.status,
);
check(
  "detection/questionnaireRefResolves",
  questionnaireRefFromTask(detectionTask) ===
    "http://example.org/Questionnaire/detection|1.2",
  String(questionnaireRefFromTask(detectionTask)),
);
check(
  "detection/taskTargetsQuestionnaire",
  taskTargetsQuestionnaire(detectionTask, detectionQuestionnaire),
  "if this fails, third parties see a form with no request behind it",
);
check(
  "detection/focusIsCanonicalNotUrnUuid",
  detectionTask.focus?.reference ===
    "http://example.org/Questionnaire/detection|1.2" &&
    detectionTask.focus?.type === "Questionnaire",
  String(detectionTask.focus?.reference),
);
check(
  "detection/inputKeepsCanonical",
  detectionTask.input?.[0]?.valueCanonical ===
    "http://example.org/Questionnaire/detection|1.2",
  "the return leg drops `focus`, so `input` is what survives",
);
check(
  "detection/addresseeIsReadable",
  detectionTask.for?.display === "Jane Citizen",
);
check(
  "detection/senderIsReadable",
  detectionTask.requester?.display === "Parkview Medical Centre",
);
check(
  "detection/descriptorOnTask",
  parseReplyDescriptor(detectionTask)?.replyUrl === descriptor.replyUrl,
);

// Platypus flattens a Bundle into a resource list and looks for a Questionnaire to decide that an SHL
// is a form invitation rather than a records import.
const flattened = (detectionBundle.entry ?? []).map((entry) => entry.resource!);
check(
  "detection/bundleFlattensToResources",
  flattened.length === 2,
  `${flattened.length} resources`,
);
check(
  "detection/questionnairePresent",
  flattened.some((r) => r.resourceType === "Questionnaire"),
);
check(
  "detection/taskFoundByStatus",
  flattened.some(
    (r) => r.resourceType === "Task" && (r as Task).status === "requested",
  ),
);

// A Questionnaire with no canonical cannot be named by reference at all; it must still produce a
// readable request rather than throwing.
const { task: urnTask } = buildRequestBundle({
  resourceType: "Questionnaire",
  id: "no-canonical",
  status: "active",
  item: [{ linkId: "q1", type: "string" }],
});
check(
  "detection/noCanonicalStillBuilds",
  urnTask.focus?.reference?.startsWith("urn:uuid:") === true,
);
check(
  "detection/noCanonicalHasNoFocusType",
  urnTask.focus?.type === undefined,
  "a type here would short-circuit the input lookup",
);

/*
 * The negative case, without which the positive ones above prove nothing: a `focus.type` of
 * 'Questionnaire' alongside a `urn:uuid` reference must NOT be detectable. This is the exact
 * half-change that looks like a tidy-up — "the focus is a Questionnaire, so say so" — and silently
 * costs every third-party filler its Task. It is asserted as a failure so that anyone who reintroduces
 * it sees why, rather than discovering it from a connectathon.
 */
check(
  "detection/urnUuidFocusWithTypeIsNotDetectable",
  !taskTargetsQuestionnaire(
    {
      ...detectionTask,
      focus: { reference: "urn:uuid:0000", type: "Questionnaire" },
    },
    detectionQuestionnaire,
  ),
  "setting focus.type without moving focus.reference to the canonical breaks detection",
);
check(
  "detection/urnUuidFocusWithoutTypeStillWorks",
  taskTargetsQuestionnaire(
    { ...detectionTask, focus: { reference: "urn:uuid:0000" } },
    detectionQuestionnaire,
  ),
  "the input canonical is the fallback that saved the previous shape",
);

// ---------------------------------------------------------------------------
// Reply bundle — the wire shape a third-party filler sends back.
// ---------------------------------------------------------------------------

console.log("\nreply bundle\n");

const answered: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  id: "local-vault-id",
  status: "completed",
  questionnaire: "http://example.org/Questionnaire/detection|1.2",
  subject: { reference: "Patient/vault-local-key" },
  author: { reference: "Patient/vault-local-key" },
  meta: { versionId: "3", lastUpdated: "2020-01-01T00:00:00Z" },
  item: [{ linkId: "q1", answer: [{ valueString: "an answer" }] }],
};

const { bundle: replyBundle, provenance: replyProvenance } = buildReplyBundle(
  answered,
  {
    requestTask: detectionTask,
  },
);
const replyPayload = parseResponseBundle(replyBundle);

check(
  "replyBundle/hasResponse",
  replyPayload.response.resourceType === "QuestionnaireResponse",
);
check(
  "replyBundle/localIdStripped",
  replyPayload.response.id === undefined,
  "a foreign id could collide on the requester server",
);
check(
  "replyBundle/patientAsserted",
  (replyPayload.response.meta?.security ?? []).some(
    (coding) => coding.code === "PATAST",
  ),
  "without this, patient-entered answers read as clinician-recorded",
);
check("replyBundle/hasProvenance", replyPayload.provenance !== undefined);
check(
  "replyBundle/provenanceTargetsResponse",
  replyProvenance?.target?.[0]?.reference === replyBundle.entry?.[0]?.fullUrl,
);
check(
  "replyBundle/provenanceNamesPatient",
  replyProvenance?.agent?.[0]?.who?.reference === "Patient/vault-local-key",
);
check(
  "replyBundle/taskCompleted",
  replyPayload.task?.status === "completed",
  replyPayload.task?.status,
);
check(
  "replyBundle/correlationSurvives",
  taskCorrelationId(replyPayload.task) === taskCorrelationId(detectionTask),
);
check(
  "replyBundle/descriptorNotEchoedBack",
  parseReplyDescriptor(replyPayload.task) === undefined &&
    !JSON.stringify(replyBundle).includes(descriptor.replyUrl),
  "returning the slot URL and its token would copy a write capability into the response",
);
check("replyBundle/noDanglingFocus", replyPayload.task?.focus === undefined);

// ---------------------------------------------------------------------------
// Attribution must survive the write. `asNewResource` is not exported, so this exercises the
// observable behaviour: what `submitResponse` sends to the server.
// ---------------------------------------------------------------------------

console.log("\nattribution on write\n");

const posted: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (init?.method === "POST") {
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json(
      {
        resourceType: url.split("/").pop(),
        id: `created-${posted.length}`,
      },
      {
        status: 201,
        headers: { "Content-Type": "application/fhir+json" },
      },
    );
  }
  // The subject probe: pretend the patient does not exist, as a real destination server would.
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const submitted = await submitResponse({
  response: replyPayload.response,
  task: replyPayload.task,
  provenance: replyPayload.provenance,
  responseServerUrl: "https://ehr.test/fhir",
});

const postedResponse = posted.find((entry) =>
  entry.url.endsWith("/QuestionnaireResponse"),
)?.body as QuestionnaireResponse | undefined;
const postedProvenance = posted.find((entry) =>
  entry.url.endsWith("/Provenance"),
)?.body as Provenance | undefined;

check(
  "write/responseCreated",
  submitted[0]?.responseId !== undefined,
  submitted[0]?.error,
);
check(
  "write/securityLabelPreserved",
  (postedResponse?.meta?.security ?? []).some(
    (coding) => coding.code === "PATAST",
  ),
  "stripping meta wholesale would silently drop the patient-asserted label",
);
check("write/versionIdStripped", postedResponse?.meta?.versionId === undefined);
check(
  "write/lastUpdatedStripped",
  postedResponse?.meta?.lastUpdated === undefined,
);
check("write/idStripped", postedResponse?.id === undefined);
check("write/provenanceCreated", submitted[0]?.provenanceId !== undefined);
check(
  "write/provenanceRetargetedToRealId",
  postedProvenance?.target?.[0]?.reference ===
    `QuestionnaireResponse/${submitted[0]?.responseId}`,
  postedProvenance?.target?.[0]?.reference,
);
check(
  "write/subjectProbeDetectsMissingPatient",
  (await referenceResolves(
    "https://ehr.test/fhir",
    "Patient/vault-local-key",
  )) === false,
);
check(
  "write/subjectProbeToleratesAbsoluteRefs",
  (await referenceResolves(
    "https://ehr.test/fhir",
    "https://elsewhere.test/Patient/1",
  )) === true,
  "an absolute reference is not ours to resolve",
);

// The endpoint declaration channel B relies on.
const declared = declareResponseEndpoint(
  detectionQuestionnaire,
  "https://ehr.test/fhir",
);
check(
  "write/endpointDeclared",
  declaredEndpoints(declared).includes("https://ehr.test/fhir"),
);
check(
  "write/endpointDeclarationIsIdempotent",
  declaredEndpoints(declareResponseEndpoint(declared, "https://ehr.test/fhir"))
    .length === 1,
);
check(
  "write/catalogueQuestionnaireUntouched",
  declaredEndpoints(detectionQuestionnaire).length === 0,
  "the forms server copy must never be mutated",
);
check(
  "write/declaredEndpointOutranksConfig",
  resolveDestinations({
    questionnaire: declared,
    responseServerUrl: "https://other.test/fhir",
  }).join(",") === "https://ehr.test/fhir",
);

globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// The published request Task — the copy that lands on the EHR so sent requests can be listed back.
//
// It differs from the invitation copy in three ways, and one of them is a hard server constraint rather
// than a preference, so it is asserted rather than assumed.
// ---------------------------------------------------------------------------

console.log("\npublished request task\n");

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
  "published/focusDropped",
  published.focus === undefined,
  "a canonical in Task.focus is rejected by FHIR servers (HAPI-0506)",
);
check(
  "published/canonicalStillRecorded",
  published.input?.[0]?.valueCanonical ===
    "http://example.org/Questionnaire/detection|1.2",
  "input[].valueCanonical is a canonical, not a Reference, so it stores",
);
check(
  "published/noExtensions",
  published.extension === undefined,
  "the reply descriptor and any write token must not reach a readable server",
);
check(
  "published/carriesNoReplyUrl",
  !JSON.stringify(published).includes(descriptor.replyUrl) &&
    !JSON.stringify(published).includes(replyKeys.publicJwk.x),
  "a published Task must reveal neither the slot nor the key",
);
check(
  "published/tagged",
  (published.meta?.tag ?? []).some(
    (tag) =>
      tag.system === SHL_REQUEST_TAG.system &&
      tag.code === SHL_REQUEST_TAG.code,
  ),
  "the tag is how sent requests are searched back out",
);
check(
  "published/correlationPreserved",
  taskCorrelationId(published) === taskCorrelationId(detectionTask),
  "the identifier is the only join between a listed Task and the locally-held reply key",
);
check("published/addresseeKept", published.for?.display === "Jane Citizen");
check(
  "published/senderKept",
  published.requester?.display === "Parkview Medical Centre",
);

// The invitation copy must be unaffected by any of that.
check(
  "published/invitationCopyKeepsCanonicalFocus",
  detectionTask.focus?.reference ===
    "http://example.org/Questionnaire/detection|1.2",
  "stripping focus for the server must not strip it from the invitation",
);
check(
  "published/invitationCopyKeepsDescriptor",
  parseReplyDescriptor(detectionTask) !== undefined,
);

// ---------------------------------------------------------------------------
// Joining the two halves of "what have I sent?".
// ---------------------------------------------------------------------------

console.log("\nsent-request merge\n");

const localRecord = {
  id: taskCorrelationId(detectionTask)!,
  label: "Detection contract",
  createdAt: "2026-08-04T02:00:00.000Z",
  link: "https://links.example.org/view#shlink:/abc",
  reply: { url: descriptor.replyUrl, privateJwk: replyKeys.privateJwk },
};

const foreignTask: Task = {
  resourceType: "Task",
  id: "server-99",
  status: "requested",
  intent: "order",
  identifier: [
    { system: "urn:ietf:rfc:3986", value: "urn:uuid:sent-elsewhere" },
  ],
  authoredOn: "2026-08-03T02:00:00.000Z",
  description: 'Complete "Physical Therapy"',
  requester: { display: "Another Practice" },
  for: { display: "John Citizen" },
};

const merged = mergeSentRequests([localRecord], [published, foreignTask]);

check(
  "merge/producesOneRowPerRequest",
  merged.length === 2,
  `${merged.length} rows`,
);

const trackedRow = merged.find((row) => row.id === localRecord.id);
check(
  "merge/joinsOnIdentifier",
  trackedRow?.origin === "tracked",
  trackedRow?.origin,
);
check("merge/trackedRowIsCollectable", trackedRow?.collectable === true);
check(
  "merge/trackedRowKeepsLocalKey",
  trackedRow?.local?.reply?.privateJwk.d === replyKeys.privateJwk.d,
);
check("merge/trackedRowGainsServerTask", trackedRow?.serverTask !== undefined);

const foreignRow = merged.find((row) => row.id === "urn:uuid:sent-elsewhere");
check(
  "merge/foreignRowIsServerOnly",
  foreignRow?.origin === "server-only",
  foreignRow?.origin,
);
check(
  "merge/foreignRowNotCollectable",
  foreignRow?.collectable === false,
  "offering a Check button that cannot work would be worse than saying why",
);
check(
  "merge/foreignRowExplainsWhy",
  whyNotCollectable(foreignRow!)?.includes("another browser") === true,
  whyNotCollectable(foreignRow!),
);
check(
  "merge/labelRecoveredFromDescription",
  foreignRow?.label === "Physical Therapy",
  `showing the raw description would read as a form named 'Complete "…"' — got ${foreignRow?.label}`,
);
check(
  "merge/newestFirst",
  merged[0]?.id === localRecord.id,
  "sorted by createdAt descending",
);

// An unpublished local record must still appear, flagged as invisible elsewhere.
const localOnly = mergeSentRequests([localRecord], []);
check(
  "merge/localOnlyRowKept",
  localOnly[0]?.origin === "local-only",
  localOnly[0]?.origin,
);
check("merge/localOnlyStillCollectable", localOnly[0]?.collectable === true);

// A Task with no identifier cannot be joined to anything, and is dropped rather than shown as a
// mystery row that no action applies to.
const unidentified = mergeSentRequests(
  [],
  [{ ...foreignTask, identifier: undefined }],
);
check("merge/dropsUnidentifiableTasks", unidentified.length === 0);

/*
 * Publishing a Task and offering channel B are different things, and the stored record has to keep them
 * apart. A Task is published for tracking whenever `publishRequestTasks` is on, so `serverTaskUrl` alone
 * does not mean a filler may write there — treating it that way made the UI warn that answers could
 * arrive unreviewed on requests where they could not.
 */
const trackedOnly = mergeSentRequests(
  [
    {
      ...localRecord,
      serverTaskUrl: "https://ehr.test/fhir/Task/1",
      serverReturnOffered: false,
    },
  ],
  [],
);
check(
  "merge/publishedIsNotDirectWrite",
  trackedOnly[0]?.local?.serverTaskUrl !== undefined &&
    trackedOnly[0]?.local?.serverReturnOffered === false,
  "a published Task is for tracking; only serverReturnOffered means answers can bypass review",
);

// Expiry removes collectability without removing the row.
const expiredLocal = mergeSentRequests([{ ...localRecord, expiresAt: 1 }], []);
check("merge/expiredIsNotCollectable", expiredLocal[0]?.collectable === false);
check(
  "merge/expiredExplainsWhy",
  whyNotCollectable(expiredLocal[0])?.includes("expired") === true,
  whyNotCollectable(expiredLocal[0]),
);

// ---------------------------------------------------------------------------
// Correlating scanned answers back to the request that asked for them.
//
// With answers returning as a link rather than into a slot, the requester no longer learns which
// request was answered from *where* the reply arrived. `Task.identifier` becomes the only thing
// carrying that, so it has to survive the round trip and the join has to be exact.

console.log("\nresponse correlation\n");

const correlationRequest = buildRequestBundle(
  {
    resourceType: "Questionnaire",
    status: "active",
    url: "http://example.org/Questionnaire/correlate",
    title: "Correlation",
  },
  { requestId: "urn:uuid:correlate-me", subjectDisplay: "Jane Citizen" },
);

const correlationLocal: OutstandingRequest = {
  id: taskCorrelationId(correlationRequest.task)!,
  label: "Correlation",
  questionnaireCanonical: "http://example.org/Questionnaire/correlate",
  createdAt: "2026-08-04T02:00:00.000Z",
  link: "https://links.example.org/view#shlink:/abc",
};

// The filler answers, echoing the Task back the way `buildReplyBundle` does.
const correlationReply = buildReplyBundle(
  {
    resourceType: "QuestionnaireResponse",
    status: "completed",
    questionnaire: "http://example.org/Questionnaire/correlate",
    item: [{ linkId: "q1", answer: [{ valueBoolean: true }] }],
  },
  { requestTask: correlationRequest.task },
);

const correlationBack = parseResponseBundle(correlationReply.bundle);
check(
  "correlate/joinsOnTaskIdentifier",
  findRequestForTask([correlationLocal], correlationBack.task)?.id ===
    correlationLocal.id,
  "the identifier is the only correlation key that survives a round trip through a third-party app",
);
check(
  "correlate/noTaskNoMatch",
  findRequestForTask([correlationLocal]) === undefined,
);
check(
  "correlate/unknownIdNoMatch",
  findRequestForTask(
    [{ ...correlationLocal, id: "urn:uuid:something-else" }],
    correlationBack.task,
  ) === undefined,
  "a link from a request this browser never sent is reviewable, not matchable",
);

check(
  "correlate/responseCanonicalWins",
  responseCanonical(
    correlationBack.response,
    "http://example.org/Questionnaire/other",
  ) === "http://example.org/Questionnaire/correlate",
);
check(
  "correlate/canonicalFallsBackToStored",
  responseCanonical(
    { ...correlationBack.response, questionnaire: undefined },
    correlationLocal.questionnaireCanonical,
  ) === correlationLocal.questionnaireCanonical,
  "a filler that dropped the canonical still answered a form whose identity we recorded",
);
check(
  "correlate/canonicalUndefinedWhenNeitherKnows",
  responseCanonical({
    ...correlationBack.response,
    questionnaire: undefined,
  }) === undefined,
  "not fatal — answers can still be read as a raw table",
);

// ---------------------------------------------------------------------------
// The encrypted reply channel, deferred.
//
// Off by default because the primary return path is a link the filler mints. These assert that
// "off" means the invitation carries nothing at all, not that it carries an unused field.

console.log("\nencrypted reply deferred\n");

check(
  "deferred/flagDefaultsOff",
  FALLBACK_CONFIG.enableEncryptedReply === false,
);
check(
  "deferred/needsBlobServer",
  canUseEncryptedReply({ ...FALLBACK_CONFIG, enableEncryptedReply: true }) ===
    false,
  "the fallback names no blob server, so the flag alone can never mint a slot",
);
check(
  "deferred/enabledWithBlobServer",
  canUseEncryptedReply({
    ...FALLBACK_CONFIG,
    enableEncryptedReply: true,
    blobServerUrl: "https://blobs.test/fhir",
  }) === true,
  "the deferral must be reversible by config alone",
);

const noChannelRequest = buildRequestBundle(
  {
    resourceType: "Questionnaire",
    status: "active",
    url: "http://example.org/Questionnaire/plain",
  },
  { requestId: "urn:uuid:no-channel", subjectDisplay: "Jane Citizen" },
);

check(
  "deferred/requestCarriesNoDescriptor",
  parseReplyDescriptor(noChannelRequest.task) === undefined,
);
check(
  "deferred/requestTaskHasNoExtensions",
  noChannelRequest.task.extension === undefined,
);
check(
  "deferred/bundleLeaksNoReplyUrl",
  !JSON.stringify(noChannelRequest.bundle).includes("shl-reply-descriptor") &&
    !JSON.stringify(noChannelRequest.bundle).includes("replyUrl"),
  "with the channel off the invitation is just the form",
);
check(
  "deferred/shippedConfigIsBoolean",
  typeof (shippedConfig as Record<string, unknown>).enableEncryptedReply ===
    "boolean",
  String((shippedConfig as Record<string, unknown>).enableEncryptedReply),
);

// ---------------------------------------------------------------------------
// `sfhl:/` is decode-only: links in the wild keep opening, nothing new is minted.

console.log("\ndecode-only codec\n");

check("bespoke/markedDecodeOnly", bespokeCodec.decodeOnly === true);
check("shl/notDecodeOnly", shlCodec.decodeOnly !== true);

let bespokeEncodingRefused = "";
try {
  encodingCodec({ ...FALLBACK_CONFIG, linkCodec: "bespoke" } as AppConfig, [
    bespokeCodec,
    shlCodec,
  ]);
} catch (error) {
  bespokeEncodingRefused = error instanceof Error ? error.message : "";
}
check(
  "bespoke/notSelectableForEncoding",
  bespokeEncodingRefused.includes("decode-only") &&
    bespokeEncodingRefused.includes("linkCodec"),
  bespokeEncodingRefused,
);
check(
  "shl/stillSelectableForEncoding",
  encodingCodec(FALLBACK_CONFIG, [bespokeCodec, shlCodec]).id === "shl",
);
check(
  "bespoke/staleConfigStillValidates",
  isAppConfig({ ...(shippedConfig as object), linkCodec: "bespoke" }),
  "a config naming a retired codec is stale, not malformed — rejecting it would discard its servers",
);

// ---------------------------------------------------------------------------
// The raw-answers fallback, now that it is pure enough to assert offline.

console.log("\nraw answers fallback\n");

const rawRows = flattenAnswers({
  resourceType: "QuestionnaireResponse",
  status: "completed",
  item: [
    {
      linkId: "group",
      text: "Symptoms",
      item: [
        { linkId: "pain", text: "Pain?", answer: [{ valueBoolean: true }] },
        {
          linkId: "site",
          text: "Where?",
          answer: [
            {
              valueCoding: { code: "123", display: "Lower back" },
              item: [
                {
                  linkId: "since",
                  text: "Since?",
                  answer: [{ valueString: "March" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

check(
  "rawAnswers/walksNestedItems",
  rawRows.some((row) => row.linkId === "pain"),
);
check(
  "rawAnswers/walksAnswerItems",
  rawRows.some((row) => row.linkId === "since" && row.value === "March"),
  "an answer can carry its own follow-up items",
);
check(
  "rawAnswers/prefersCodingDisplay",
  rawRows.find((row) => row.linkId === "site")?.value === "Lower back",
  "a coded answer rendered as [object Object] is useless to someone deciding whether to accept it",
);
check(
  "rawAnswers/nestedItemIsNotAValue",
  rawRows.find((row) => row.linkId === "site")?.value !== undefined &&
    !JSON.stringify(rawRows).includes('"value":"[object Object]"'),
);

/*
 * An answer is a BackboneElement, so it may carry `id`, `extension` and `modifierExtension` beside
 * its `value[x]`. Picking "whatever field is left over" makes the rendered answer depend on the
 * sending app's JSON key order — which fails intermittently rather than reproducibly, and this is
 * the only rendering available when the Questionnaire cannot be resolved.
 */
const backboneRows = flattenAnswers({
  resourceType: "QuestionnaireResponse",
  status: "completed",
  item: [
    { linkId: "lead-id", answer: [{ id: "a1", valueBoolean: true }] },
    {
      linkId: "lead-ext",
      answer: [
        { extension: [{ url: "http://x", valueInteger: 3 }], valueInteger: 7 },
      ],
    },
    { linkId: "trailing-id", answer: [{ valueString: "yes", id: "z" }] },
  ],
});

check(
  "rawAnswers/ignoresAnswerId",
  backboneRows.find((row) => row.linkId === "lead-id")?.value === "true",
  backboneRows.find((row) => row.linkId === "lead-id")?.value,
);
check(
  "rawAnswers/ignoresAnswerExtension",
  backboneRows.find((row) => row.linkId === "lead-ext")?.value === "7",
  backboneRows.find((row) => row.linkId === "lead-ext")?.value,
);
check(
  "rawAnswers/keyOrderDoesNotMatter",
  backboneRows.find((row) => row.linkId === "trailing-id")?.value === "yes",
  "a foreign app serialising id after value must render the same as one serialising it before",
);
check(
  "rawAnswers/indentsByDepth",
  rawRows.find((row) => row.linkId === "pain")?.depth === 1,
);
check(
  "rawAnswers/emptyResponseYieldsNoRows",
  flattenAnswers({ resourceType: "QuestionnaireResponse", status: "completed" })
    .length === 0,
);

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
