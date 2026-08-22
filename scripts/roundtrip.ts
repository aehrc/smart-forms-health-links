/**
 * Offline checks for the link layer, run against the real QuestionnaireResponse fixtures
 * from the smart-forms repo. Bundled with esbuild and run in Node, which supports the same
 * CompressionStream/btoa APIs the browser codec uses.
 *
 *   npm run check:roundtrip
 *
 * The fixture imports below reach into a sibling checkout of aehrc/smart-forms. That is the only
 * coupling between the two repos and it is dev-only - if the checkout is missing or moved, this
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
import {
  declareResponseEndpoint,
  declaredEndpoints,
  referenceResolves,
  resolveDestinations,
  submitResponse,
} from "../src/fhir/submit";
import { flattenAnswers } from "../src/lib/answerRows";
import { FALLBACK_CONFIG, isAppConfig } from "../src/lib/config";
import { bespokeCodec } from "../src/link/bespokeCodec";
import {
  decodeUtf8,
  encodeUtf8,
  fromBase64Url,
  toBase64Url,
} from "../src/link/binary";
import {
  PasscodeRequiredError,
  bundleResponse,
  extractFragment,
  responseFromBundle,
} from "../src/link/codec";
import {
  buildReplyBundle,
  buildRequestBundle,
  isRequestBundle,
  parseResponseBundle,
  responseCanonical,
  taskCorrelationId,
  taskFormLabel,
  taskQuestionnaireCanonical,
} from "../src/link/exchange";
import {
  SHL_REQUEST_TAG,
  asPublishedTask,
  buildInvitationBundle,
} from "../src/link/invitationBundle";
import {
  decryptJwe,
  encryptJwe,
  generateKey,
  keyToBase64Url,
} from "../src/link/jwe";
import { chooseErrorCorrectionLevel } from "../src/link/qrCapacity";
import {
  decryptReplyJwe,
  encryptReplyJwe,
  generateReplyKeyPair,
  looksLikeReplyJwe,
} from "../src/link/replyCrypto";
import {
  REPLY_DESCRIPTOR_EXTENSION,
  buildReplyDescriptorExtension,
  buildServerTaskUrlExtension,
  isReplyDescriptorExpired,
  parseReplyDescriptor,
  parseServerTaskUrl,
} from "../src/link/replyDescriptor";
import { shlCodec } from "../src/link/shlCodec";

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
 * @param name the label printed for the assertion
 * @param condition the assertion result; a false value counts a failure
 * @param detail extra context appended to the printed line, if any
 */
function check(name: string, condition: boolean, detail = "") {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`,
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

/*
 * No assertion here names a data server, and that absence is the point. The configuration used to
 * name three - a forms catalogue, a response server and a blob host - because the app had no
 * launch context and had to be told where everything was. It has one now: the requester signs in
 * and reads and writes that server through the BFF proxy, and the permitted servers are the
 * deployment's issuer registry on the server side rather than a URL the browser could be pointed
 * at (FR-004, FR-030).
 */
check(
  "config/namesNoDataServer",
  !JSON.stringify(shippedConfig).includes("responseServerUrl") &&
    !JSON.stringify(shippedConfig).includes("blobServerUrl") &&
    !JSON.stringify(shippedConfig).includes("formsServerUrl"),
  JSON.stringify(shippedConfig),
);
check(
  "config/fallbackNamesNoDataServer",
  !JSON.stringify(FALLBACK_CONFIG).includes("ServerUrl") ||
    Object.keys(FALLBACK_CONFIG).filter((key) => key.endsWith("ServerUrl"))
      .length === 1,
  "only the terminology server is left, and it holds no patient data",
);

// ---------------------------------------------------------------------------
// JWE (alg=dir, enc=A256GCM) - the crypto layer SMART Health Links requires.
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

// A wrong key must fail, not return garbage - this is the whole security property.
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
  bytes[0] ^= 0b1111_1111;
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
// SHL codec against an in-memory host - no network, no hosting tier.
//
// This app no longer mints SMART Health Links from the browser: a requester's invitation is
// minted, published and hosted by the BFF (`POST /api/invitations`), and the third-party blob
// store the codec used to write through was deleted with the rest of anonymous mode. So the
// host below is a stand-in for whoever *else* hosted a link that arrives here - which is the
// only direction this codec still travels.
// ---------------------------------------------------------------------------

console.log("\nSMART Health Links\n");

const blobs = new Map<string, Uint8Array>();
let hosted = 0;
const store = {
  /**
   * Host bytes under a fresh URL.
   * @param bytes the payload to host
   * @returns the URL the fetch shim below resolves
   */
  put(bytes: Uint8Array): string {
    hosted += 1;
    const url = `https://host.test/Binary/${hosted}`;
    blobs.set(url, bytes);
    return url;
  },
  /**
   * Read hosted bytes back.
   * @param url the hosting URL
   * @returns the bytes, or undefined when nothing is hosted there
   */
  get(url: string): Uint8Array | undefined {
    return blobs.get(url);
  },
};

/**
 * The URL a `fetch` argument names, in whichever of its three forms it arrived.
 * @param input the first argument handed to `fetch`
 * @returns the URL as a string
 */
function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

// The codec fetches its payload by URL; serve the in-memory store through a fetch shim.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = fetchUrl(input);
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

/*
 * A `U`-flag link somebody else minted: one encrypted file, fetched with a plain `GET`. That is
 * the shape the fallback return channel produces, so reading it has to keep working even though
 * this app can no longer write it.
 */
const shlKey = generateKey();
const shlBlobUrl = store.put(
  encodeUtf8(await encryptJwe(encodeUtf8(JSON.stringify(shlBundle)), shlKey)),
);
const shlPayload = {
  url: shlBlobUrl,
  key: keyToBase64Url(shlKey),
  flag: "U",
  v: 1,
  label: "Medical History",
};
const shlLink = `${BASE_URL}/view#shlink:/${toBase64Url(
  encodeUtf8(JSON.stringify(shlPayload)),
)}`;

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
check("shl/keyIs43Chars", shlPayload.key.length === 43);

const shlDecoded = await shlCodec.decode(shlLink);
check(
  "shl/roundTrip",
  JSON.stringify(responseFromBundle(shlDecoded.bundle)) ===
    JSON.stringify(responseFromBundle(shlBundle)),
);
check("shl/labelSurvives", shlDecoded.label === "Medical History");

// The hosted payload must be opaque: no plaintext answers recoverable from it.
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

/*
 * The codec cannot mint at all any more, and that has to be an explicit refusal rather than a
 * `TypeError` a layer down: hosting an SHL means being a manifest server, and this deployment's
 * manifest server is its own BFF.
 */
check(
  "shl/hasNoEncoder",
  shlCodec.encode === undefined,
  "minting moved to POST /api/invitations",
);

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

/**
 * Host a JWE of `content` under `key` and mint the `shlink:` fragment that points at it.
 * @param content the value serialised as JSON and encrypted into the hosted file
 * @param key the symmetric key used for both the JWE and the link's `key` field
 * @param extra further fields merged into the `shlink:` payload, such as `flag`
 * @returns the hosted file's URL and the `shlink:` fragment that points at it
 */
async function hostShl(
  content: unknown,
  key: Uint8Array,
  extra: Record<string, unknown> = {},
) {
  const url = store.put(
    encodeUtf8(await encryptJwe(encodeUtf8(JSON.stringify(content)), key)),
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

// A bare resource, not a Bundle - an entirely ordinary `application/fhir+json` payload.
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
  const url = fetchUrl(input);
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

/**
 * Encrypt `content` under the foreign key and host it, returning just the URL.
 * @param content the resource or Bundle to place in a single hosted file
 * @returns the URL of the hosted file
 */
const hostFile = async (content: unknown) => {
  const hosted = await hostShl(content, foreignKey);
  return hosted.url;
};

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
const parameterisedRead = await shlCodec.decode(manifestLink);
check(
  "foreign/manifestToleratesContentTypeParameters",
  parseResponseBundle(parameterisedRead.bundle).response !== undefined,
);

// One unreadable file must cost its own content, not the whole link.
const corruptUrl = store.put(encodeUtf8("not.a.valid.jwe.at-all"));
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
const manifestRequestRead = await shlCodec.decode(manifestLink);
check(
  "foreign/manifestRequestStillRoutesAsRequest",
  isRequestBundle(manifestRequestRead.bundle),
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
const embeddedRead = await shlCodec.decode(manifestLink);
check(
  "foreign/manifestReadsEmbedded",
  parseResponseBundle(embeddedRead.bundle).response !== undefined,
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

const passcodeRead = await shlCodec.decode(manifestLink, {
  passcode: "letmein",
});
check(
  "passcode/correctPasscodeSucceeds",
  parseResponseBundle(passcodeRead.bundle).response !== undefined,
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
const pFlagRead = await shlCodec.decode(pFlagLink, { passcode: "letmein" });
check(
  "passcode/pFlagOpensWhenSupplied",
  parseResponseBundle(pFlagRead.bundle).response !== undefined,
);

manifestPasscode = undefined;
globalThis.fetch = realFetch;

// The optional argument must not have disturbed the other codec's narrower signature.
const bespokeWithOptions = await bespokeCodec.encode(
  { bundle: bundleResponse(foreignResponse), label: "unaffected" },
  { baseUrl: BASE_URL },
);
const bespokeRead = await bespokeCodec.decode(bespokeWithOptions, {
  passcode: "x",
});
check(
  "passcode/bespokeSignatureUnaffected",
  responseFromBundle(bespokeRead.bundle).status === "completed",
);

// ---------------------------------------------------------------------------
// Reply crypto (ECDH-ES + A256GCM) - channel C.
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
  Object.keys(replyKeys.publicJwk).toSorted().join(",") === "crv,kty,x,y",
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
    const mutated = await mutate([...replySegments]);
    await decryptReplyJwe(mutated.join("."), key);
    return false;
  } catch {
    return true;
  }
}

const otherReplyKeys = await generateReplyKeyPair();
check(
  "reply/wrongKeyRejected",
  await replyRejects((segments) => segments, otherReplyKeys.privateJwk),
);
check(
  "reply/tamperedCiphertextRejected",
  await replyRejects((segments) => {
    const bytes = fromBase64Url(segments[3]);
    bytes[0] ^= 0b1111_1111;
    segments[3] = toBase64Url(bytes);
    return segments;
  }),
);
check(
  "reply/tamperedEpkRejected",
  await replyRejects(async (segments) => {
    const header = JSON.parse(decodeUtf8(fromBase64Url(segments[0])));
    const epkKeys = await generateReplyKeyPair();
    header.epk = epkKeys.publicJwk;
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
/*
 * A slot this app did not mint may hold anything at all before it is answered - Platypus writes a
 * sentinel, other hosts write nothing - so "answered" has to be decided structurally rather than
 * by recognising a particular placeholder.
 */
check(
  "reply/looksLikeReplyJwe:rejectsPlaceholder",
  !looksLikeReplyJwe(`pending:${crypto.randomUUID()}`),
);
check("reply/looksLikeReplyJwe:rejectsEmpty", !looksLikeReplyJwe(""));

// ---------------------------------------------------------------------------
// Reply descriptor - build, parse, and tolerance of Platypus's own identifiers.
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
// every return channel - degrading to a form nobody can send back.
// ---------------------------------------------------------------------------

console.log("\nplatypus detection contract\n");

/**
 * Verbatim port of Platypus's `questionnaireRefFromTask`.
 * @param task the invitation Task to search for a Questionnaire reference
 * @returns the Questionnaire reference, or `undefined` if the Task names none
 */
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

/**
 * Verbatim port of Platypus's `refMatchesQuestionnaire` + `taskTargetsQuestionnaire`.
 * @param task the invitation Task whose Questionnaire reference is under test
 * @param q the Questionnaire the Task must name, by `url` or by `id`
 * @returns whether the Task names that Questionnaire
 */
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
 * half-change that looks like a tidy-up ("the focus is a Questionnaire, so say so") and silently
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
// Reply bundle - the wire shape a third-party filler sends back.
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
  const url = fetchUrl(input);
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
  submitted.results[0]?.responseId !== undefined,
  submitted.results[0]?.error,
);
/*
 * This reply's Task names no `invitation-server-task-url`, so there is no published request for
 * the write to complete - and the answers are stored anyway. That is the third-party case, and it
 * is reported rather than silently skipped.
 */
check(
  "write/noPublishedTaskToComplete",
  submitted.task.kind === "skipped" && submitted.task.detail.length > 0,
  submitted.task.detail,
);
check(
  "write/noStrayTaskCreated",
  !posted.some((entry) => entry.url.endsWith("/Task")),
  "a POSTed Task copy would leave the published request awaiting answers forever",
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
check(
  "write/provenanceCreated",
  submitted.results[0]?.provenanceId !== undefined,
);
check(
  "write/provenanceRetargetedToRealId",
  postedProvenance?.target?.[0]?.reference ===
    `QuestionnaireResponse/${submitted.results[0]?.responseId}`,
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
  "the copy on the launched server must never be mutated",
);
check(
  "write/declaredEndpointOutranksLaunchedServer",
  resolveDestinations({
    questionnaire: declared,
    responseServerUrl: "https://other.test/fhir",
  }).join(",") === "https://ehr.test/fhir",
);

globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// The published request Task - the copy that lands on the EHR so sent requests can be listed back.
//
// It differs from the invitation copy in three ways, and one of them is a hard server constraint rather
// than a preference, so it is asserted rather than assumed.
// ---------------------------------------------------------------------------

console.log("\npublished request task\n");

const published = asPublishedTask(detectionTask);

/*
 * The load-bearing one. The invitation names the Questionnaire by canonical because that is the only
 * form of the reference a filler can still use once the Bundle is taken apart - but `Task.focus` is a
 * `Reference`, and a FHIR server will not store a canonical there:
 *
 *   HAPI-0506: Invalid resource reference found at path[Task.focus] - Resource type is unknown or not
 *              supported on this server - http://example.org/Questionnaire/detection|1.2
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
  "the identifier is the only join between a listed Task and the one that comes back",
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
// Naming the form a request asked for.
//
// `/requests` and the review screen both label a request from its Task and nothing else, so the
// label has to be recoverable from the Task alone. This used to be one half of a merge with a
// browser-local record of the mint; that record is gone, so the Task is the whole of it.

console.log("\nrequest labels\n");

check(
  "label/recoveredFromDescription",
  taskFormLabel({
    ...published,
    description: 'Complete "Physical Therapy"',
  }) === "Physical Therapy",
  "showing the raw description would read as a form named 'Complete \"…\"'",
);
check(
  "label/fallsBackToCanonical",
  taskFormLabel({ ...published, description: undefined }) === "detection",
  "input[].valueCanonical is what survives on a returned Task, so it is the fallback",
);
check(
  "label/undefinedWhenTaskSaysNothing",
  taskFormLabel({
    resourceType: "Task",
    status: "requested",
    intent: "order",
  }) === undefined,
  "a placeholder here would beat the questionnaire title a caller may already have",
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
  {
    requestId: "urn:uuid:correlate-me",
    subjectReference: "Patient/pt-1",
    subjectDisplay: "Jane Citizen",
  },
);

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
  "correlate/identifierSurvivesRoundTrip",
  taskCorrelationId(correlationBack.task) ===
    taskCorrelationId(correlationRequest.task),
  "the identifier is the only correlation key that survives a round trip through a third-party app",
);
/*
 * The returned Task is the requester's own invitation Task come back, so `for` still names the
 * patient on the requester's own server. That is what the review screen offers as a one-click
 * reconciliation when the answers themselves name nobody - which is the normal case for an
 * anonymous filler, and it used to be answered from a browser-local record of the mint.
 */
check(
  "correlate/addresseeSurvivesRoundTrip",
  correlationBack.task?.for?.reference === "Patient/pt-1" &&
    correlationBack.task?.for?.display === "Jane Citizen",
  JSON.stringify(correlationBack.task?.for),
);

check(
  "correlate/responseCanonicalWins",
  responseCanonical(
    correlationBack.response,
    "http://example.org/Questionnaire/other",
  ) === "http://example.org/Questionnaire/correlate",
);
check(
  "correlate/canonicalFallsBackToTask",
  responseCanonical(
    { ...correlationBack.response, questionnaire: undefined },
    taskQuestionnaireCanonical(correlationBack.task),
  ) === "http://example.org/Questionnaire/correlate",
  "a filler that dropped the canonical still answered a form the returned Task names",
);
check(
  "correlate/canonicalUndefinedWhenNeitherKnows",
  responseCanonical({
    ...correlationBack.response,
    questionnaire: undefined,
  }) === undefined,
  "not fatal - answers can still be read as a raw table",
);

// ---------------------------------------------------------------------------
// The encrypted reply channel, no longer minted.
//
// This app stopped offering channel C on its own invitations (FR-029): answers come back through
// the grant, or as a link the filler mints. The filler half stays, so somebody else's invitation
// that declares a reply channel is still honoured - that is asserted above, in "reply descriptor".
// What is asserted here is the other half: an invitation minted now carries nothing at all about
// a reply slot, rather than carrying an unused field.

console.log("\nencrypted reply no longer minted\n");

const noChannelRequest = buildInvitationBundle({
  resourceType: "Questionnaire",
  status: "active",
  url: "http://example.org/Questionnaire/plain",
});

check(
  "deferred/requestCarriesNoDescriptor",
  parseReplyDescriptor(noChannelRequest.task) === undefined,
);
check(
  "deferred/requestTaskHasNoExtensions",
  noChannelRequest.task.extension === undefined,
  "the only extension an invitation carries is the published Task's URL",
);
check(
  "deferred/bundleLeaksNoReplyUrl",
  !JSON.stringify(noChannelRequest.bundle).includes("shl-reply-descriptor") &&
    !JSON.stringify(noChannelRequest.bundle).includes("replyUrl"),
  "with the channel gone the invitation is just the form",
);

// ---------------------------------------------------------------------------
// Each direction has exactly one transport, and neither is chosen by configuration. An invitation
// is minted by the BFF, which hosts it (`shlink:/`, no `encode` in the browser at all); a return
// is minted here and hosted nowhere (`sfhl:/`, inline). Reading accepts both, always.

console.log("\ncodec selection\n");

check(
  "bespoke/mintsInline",
  typeof bespokeCodec.encode === "function",
  "the filler's return leg has no host, so its transport must mint without one",
);
check(
  "shl/doesNotMintInTheBrowser",
  shlCodec.encode === undefined,
  "hosting an SHL belongs to the server; the browser asks `POST /api/invitations`",
);
check(
  "codecs/bothStillDecode",
  bespokeCodec.canDecode("sfhl:/abc") && shlCodec.canDecode("shlink:/abc"),
);
check(
  "config/namesNoCodec",
  !JSON.stringify(shippedConfig).includes("linkCodec") &&
    !JSON.stringify(FALLBACK_CONFIG).includes("linkCodec"),
  "nothing selects a codec by configuration any more",
);
check(
  "config/staleCodecKeyStillValidates",
  isAppConfig({ ...(shippedConfig as object), linkCodec: "bespoke" }),
  "a config left over from when the key existed is stale, not malformed - rejecting it would discard its servers",
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
 * sending app's JSON key order - which fails intermittently rather than reproducibly, and this is
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
