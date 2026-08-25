/**
 * Live end-to-end check of pre-population, from the real catalogue to a real record.
 *
 *   catalogue: search the real forms server -> confirm it still holds populatable forms
 *   populate:  run $populate against a real patient on a real EHR -> answers came back
 *   choose:    flatten to rows, untick one -> the pruned seed lost exactly that answer
 *   seal:      mint a request carrying the seed -> decode it -> the seed survived, intact
 *
 * Three things here cannot be checked offline, and each is a way the feature fails silently rather
 * than loudly.
 *
 * The **catalogue** count is the first. Pre-population is worth having because most forms declare it —
 * 112 of 138 at the time of writing, against 25 for extraction — and if that ever drops to zero the
 * toggle simply stops appearing and nothing else in the suite would notice.
 *
 * The **populate** step is the second, and it is the one `check:roundtrip` structurally cannot reach:
 * whether a real server answers a form's `x-fhir-query` searches at all. A refused search and an empty
 * record are the same empty answer, which is exactly why this is asserted against a patient known to
 * have a history rather than assumed.
 *
 * The **round trip** is the third. A seed that survives `buildRequestBundle` in a unit check may still
 * be lost to encryption, hosting and decode — and a lost seed degrades to a blank form, which looks
 * like a working request.
 *
 * The forms server is read ONLY, and so is the EHR: this check creates nothing and deletes nothing.
 * The one thing it writes is the encrypted payload, to `SHL_BLOB_SERVER`.
 *
 *   SHL_EHR_SERVER=https://proxy.smartforms.io/fhir \
 *   SHL_BLOB_SERVER=https://proxy.smartforms.io/fhir \
 *   SHL_PATIENT=example-dm-complications npm run check:populate
 */
import type { Patient, Questionnaire } from 'fhir/r4';
import { searchQuestionnaires } from '../src/fhir/formsServer';
import { questionnaireDeclaresPopulation, prePopulate } from '../src/fhir/populate';
import { populatedRows, pruneAnswers } from '../src/lib/answerRows';
import { fhirBinaryBlobStore } from '../src/fhir/blobStore';
import { buildRequestBundle, isRequestBundle, parseRequestBundle } from '../src/link/exchange';
import { shlCodec } from '../src/link/shlCodec';
import type { SmartSession } from '../src/auth/smartSession';

const FORMS_SERVER = 'https://smartforms.csiro.au/api/fhir';
const EHR_SERVER = process.env.SHL_EHR_SERVER;
const BLOB_SERVER = process.env.SHL_BLOB_SERVER ?? EHR_SERVER;
const PATIENT_ID = process.env.SHL_PATIENT ?? 'example-dm-complications';

if (!EHR_SERVER) {
  console.log(
    'Skipped: set SHL_EHR_SERVER to a FHIR server holding a patient with some history.\n' +
      '  Nothing is created on it — populate is a read — but the encrypted payload is POSTed to\n' +
      '  SHL_BLOB_SERVER (defaults to the same server).\n' +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      '  SHL_EHR_SERVER=https://proxy.smartforms.io/fhir npm run check:populate'
  );
  process.exit(0);
}

if (EHR_SERVER.replace(/\/+$/, '') === FORMS_SERVER) {
  console.error(
    `Refusing to run: SHL_EHR_SERVER is the forms server (${FORMS_SERVER}).\n` +
      'That server is a read-only catalogue of questionnaires, not a record to populate from.'
  );
  process.exit(1);
}

let failures = 0;
let total = 0;

function check(name: string, condition: boolean, detail = '') {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log(`forms server (read only): ${FORMS_SERVER}`);
console.log(`EHR server (read only):   ${EHR_SERVER}`);
console.log(`blob server:              ${BLOB_SERVER}\n`);

// ---------------------------------------------------------------------------
console.log('--- catalogue: does the real forms server still hold populatable forms? ---');

const catalogue = await searchQuestionnaires(FORMS_SERVER, '', 200);
const populatable = catalogue.filter((candidate) => questionnaireDeclaresPopulation(candidate));

check(
  'catalogue/holdsPopulatableForms',
  populatable.length > 0,
  `${populatable.length} of ${catalogue.length} declare population machinery`
);

/*
 * Picked by name rather than taken from the head of the list. The GP plan is the form the README
 * measures everything against, and — unlike most of the catalogue — it populates a *repeating group*,
 * which is the shape that decided this feature's design. A form that only fills flat fields would pass
 * this check while leaving the interesting half untested.
 */
const chosen: Questionnaire | undefined =
  populatable.find((candidate) => candidate.id === 'GPChronicConditionManagementPlan') ??
  populatable[0];

if (!chosen) {
  console.error('No populatable form on the catalogue; nothing further can be checked.');
  process.exit(1);
}

console.log(`  form: ${chosen.title ?? chosen.id}`);

// ---------------------------------------------------------------------------
console.log('\n--- populate: against a real patient on a real record ---');

const patientResponse = await fetch(`${EHR_SERVER.replace(/\/+$/, '')}/Patient/${PATIENT_ID}`, {
  headers: { Accept: 'application/fhir+json' }
});

if (!patientResponse.ok) {
  console.error(
    `Could not read Patient/${PATIENT_ID} from ${EHR_SERVER} (${patientResponse.status}). ` +
      'Set SHL_PATIENT to a patient this server holds.'
  );
  process.exit(1);
}

const patient = (await patientResponse.json()) as Patient;

/*
 * An unauthenticated stand-in for a launched session. `authedFetch` gates on origin *and* on the
 * header being non-null, so this reads the open sandbox exactly as an anonymous client would — which
 * is what a check harness can do and what the app itself refuses to do. `canPrePopulate` requires a
 * real session precisely because a bulk clinical read with no identity should not be routine.
 */
const session = {
  serverUrl: EHR_SERVER,
  authorizationHeader: async () => null
} as unknown as SmartSession;

const started = Date.now();
const { response: populated, issues } = await prePopulate({
  questionnaire: chosen,
  ehrServerUrl: EHR_SERVER,
  session,
  patient
});
const elapsed = Date.now() - started;

check('populate/returnedAResponse', populated !== null, `${elapsed} ms`);

if (!populated) {
  console.error('\nPopulate returned nothing, so the rest cannot be checked.');
  process.exit(1);
}

const rows = populatedRows(populated);
check(
  'populate/producedAnswers',
  rows.length > 0,
  `${rows.length} answers${issues ? `, ${(issues.issue ?? []).length} issue(s)` : ''}`
);
check(
  'populate/statusIsInProgress',
  populated.status === 'in-progress',
  'the discriminator reads this to tell an invitation from an answer'
);

const repeated = rows.filter((row) => row.groups.some((group) => /\s2$/.test(group)));
check(
  'populate/filledARepeatingGroup',
  repeated.length > 0,
  repeated.length > 0
    ? `${repeated.length} answers in a second group instance — the shape item.initial cannot express`
    : 'this patient has no list-shaped history, so the interesting case went unchecked'
);

// ---------------------------------------------------------------------------
console.log('\n--- choose: unticking a row removes exactly that answer ---');

const dropped = rows[rows.length - 1];
const keep = new Set(rows.filter((row) => row.path !== dropped.path).map((row) => row.path));
const seed = pruneAnswers(populated, keep);
const seedRows = populatedRows(seed);

check('choose/prunedExactlyOne', seedRows.length === rows.length - 1);
check(
  'choose/prunedTheRightOne',
  !seedRows.some((row) => row.path === dropped.path),
  `dropped "${dropped.text ?? dropped.linkId}"`
);
check('choose/leftTheOriginalAlone', populatedRows(populated).length === rows.length);

// ---------------------------------------------------------------------------
console.log('\n--- seal: mint a real link and read the seed back out of it ---');

/*
 * `buildRequestBundle` + the codec directly, rather than `createRequestLink`. That layer is where the
 * renderer's global form state meets the codecs, so importing it pulls `@aehrc/smart-forms-renderer`
 * into the bundle — and esbuild has no loader for the `.woff2` it ships. `e2eShl.ts` mints the same
 * way for the same reason.
 */
const { bundle: requestBundle } = buildRequestBundle(chosen, {
  subjectReference: `Patient/${PATIENT_ID}`,
  subjectDisplay: patient.name?.[0]?.family ?? 'Test Patient',
  prePopulated: seed
});

const link = await shlCodec.encode(
  { bundle: requestBundle, label: chosen.title ?? 'Questionnaire' },
  { baseUrl: 'https://example.org', blobStore: fhirBinaryBlobStore(BLOB_SERVER!) }
);

const decoded = await shlCodec.decode(link.slice(link.indexOf('#')));

check('seal/stillReadsAsARequest', isRequestBundle(decoded.bundle), 'not as a completed response');

const payload = parseRequestBundle(decoded.bundle);
check('seal/seedSurvivedTheRoundTrip', payload.prePopulated !== undefined);
check(
  'seal/everyKeptAnswerCameBack',
  payload.prePopulated !== undefined &&
    populatedRows(payload.prePopulated).length === seedRows.length,
  `${payload.prePopulated ? populatedRows(payload.prePopulated).length : 0} of ${seedRows.length}`
);
check(
  'seal/theUntickedAnswerDidNot',
  payload.prePopulated !== undefined &&
    !populatedRows(payload.prePopulated).some((row) => row.path === dropped.path)
);
check(
  'seal/seedCarriesNoAuthorship',
  payload.prePopulated?.author === undefined && payload.prePopulated?.meta?.security === undefined,
  'nothing that would return as a claim about who asserted the answers'
);

const questionnaireBytes = JSON.stringify(payload.questionnaire).length;
const seedBytes = JSON.stringify(payload.prePopulated ?? {}).length;
console.log(
  `\n  questionnaire ${(questionnaireBytes / 1024).toFixed(0)} KB · seed ${seedBytes} B · ` +
    `+${((seedBytes / questionnaireBytes) * 100).toFixed(1)}% · link ${link.length} bytes`
);

console.log(
  failures === 0 ? `\nAll ${total} checks passed.` : `\n${failures} of ${total} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
