/**
 * Round-trip check for the Phase 1 link codec, run against the real QuestionnaireResponse fixtures
 * from the smart-forms repo. Bundled with esbuild and run in Node, which supports the same
 * CompressionStream/btoa APIs the browser codec uses.
 *
 *   npm run check:roundtrip
 *
 * The fixture imports below reach into a sibling checkout of aehrc/smart-forms. That is the only
 * coupling between the two repos and it is dev-only — if the checkout is missing or moved, this
 * script fails to bundle but the app itself is unaffected.
 */
import { bespokeCodec } from '../src/link/bespokeCodec';
import { shlCodec } from '../src/link/shlCodec';
import { bundleResponse, responseFromBundle, extractFragment } from '../src/link/codec';
import { chooseErrorCorrectionLevel } from '../src/link/qrCapacity';
import { decodeUtf8, encodeUtf8, fromBase64Url, toBase64Url } from '../src/link/binary';
import { decryptJwe, encryptJwe, generateKey, keyToBase64Url } from '../src/link/jwe';
import { inMemoryBlobStore } from '../src/fhir/blobStore';

import { QRSepsisRisk } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRSepsisRisk';
import { QRRegularMedications } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRRegularMedications';
import { QRMedicalHistoryCurrentProblems } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRMedicalHistoryCurrentProblems';

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

globalThis.fetch = realFetch;

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
