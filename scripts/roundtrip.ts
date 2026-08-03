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
import assert from 'node:assert/strict';
import { bespokeCodec } from '../src/link/bespokeCodec';
import { bundleResponse, responseFromBundle, extractFragment } from '../src/link/codec';
import { chooseErrorCorrectionLevel, MAX_QR_BYTES } from '../src/link/qrCapacity';

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

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    return;
  }
  failures++;
  console.error(`  FAIL ${name} ${detail}`);
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

  check(name, identical, 'decoded payload differs from input');
  check(name, link.startsWith(`${BASE_URL}/view#sfhl:/`), 'unexpected link shape');
  check(name, level !== null, `link exceeds ${MAX_QR_BYTES} bytes`);
}

// Codec discrimination: the bespoke codec must not claim SHL links, and vice versa.
check(
  'canDecode/shlink',
  !bespokeCodec.canDecode('https://viewer.example.org#shlink:/eyJ1cmwiOiJ4In0'),
  'bespoke codec claimed an shlink'
);
check('canDecode/garbage', !bespokeCodec.canDecode('https://example.org/nothing'), '');
check('canDecode/bare', bespokeCodec.canDecode('sfhl:/abc'), 'bare fragment not recognised');

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
  check(`decode/${label}`, threw, 'corrupt payload decoded without error');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
