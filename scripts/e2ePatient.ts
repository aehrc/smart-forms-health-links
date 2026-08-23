/**
 * Live check of creating a patient during reconciliation.
 *
 *   answers arrive for somebody the destination server has never heard of
 *     -> search finds nobody
 *     -> POST /Patient
 *     -> the QuestionnaireResponse that could not be written now can be
 *
 * The last step is the whole feature, and it is only meaningful next to its control: the same write
 * with the filler's original unresolvable subject must *still* be rejected. Without that, the success
 * could just as easily mean the server stopped enforcing referential integrity, and the check would be
 * proving nothing.
 *
 * Everything written — one Patient and two QuestionnaireResponses — goes to `SHL_WRITE_SERVER` and is
 * deleted afterwards in reverse dependency order. The Patient goes last, or the delete 409s.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:patient
 */
import type { Patient, QuestionnaireResponse } from 'fhir/r4';
import { createPatient, submitResponse } from '../src/fhir/submit';
import { buildPatient, splitName } from '../src/fhir/newPatient';
import { describePatient, patientDisplay, searchPatients } from '../src/fhir/ehrServer';

const FORMS_SERVER = 'https://smartforms.csiro.au/api/fhir';
const WRITE_SERVER = process.env.SHL_WRITE_SERVER;

if (!WRITE_SERVER) {
  console.log(
    'Skipped: set SHL_WRITE_SERVER to a FHIR server this test may write to.\n' +
      '  It creates a Patient and two QuestionnaireResponses, and cleans up after itself.\n' +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      '  SHL_WRITE_SERVER=https://your-server/fhir npm run check:patient'
  );
  process.exit(0);
}

if (WRITE_SERVER.replace(/\/+$/, '') === FORMS_SERVER) {
  console.error(
    `Refusing to run: SHL_WRITE_SERVER is the forms server (${FORMS_SERVER}).\n` +
      'That server is a read-only catalogue of questionnaires; writing test data into it pollutes a\n' +
      'shared resource other people search.'
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

const created: { type: string; id: string }[] = [];

async function read<T>(type: string, id: string): Promise<T> {
  const response = await fetch(`${WRITE_SERVER}/${type}/${id}`, {
    headers: { Accept: 'application/fhir+json' }
  });
  if (!response.ok) {
    throw new Error(`GET ${type}/${id} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Run-scoped, so "nobody by that name" is genuinely true and any leftover is traceable to this run. */
const FAMILY = `Zz-Shl-Check-${crypto.randomUUID().slice(0, 8)}`;
const GIVEN = 'Jane Alexandra';
const BIRTH_DATE = '1984-03-02';
const CANONICAL = 'http://example.org/Questionnaire/create-patient-probe';

console.log(`write server: ${WRITE_SERVER}`);
console.log(`family name:  ${FAMILY}\n`);

try {
  console.log('--- the builder asserts only what it was told ---');
  const bare = buildPatient({ family: 'Citizen', given: '', birthDate: '', gender: undefined });
  check('no id is invented', bare.id === undefined);
  check('no identifier is fabricated', bare.identifier === undefined);
  /*
   * `name.text` and the parts disagreeing after somebody edits one is a real data-quality trap, and
   * `patientDisplay` falls back to the joined parts anyway, so omitting it costs nothing.
   */
  check('no full-text name is synthesised', bare.name?.[0]?.text === undefined);
  check('an empty given list is omitted', bare.name?.[0]?.given === undefined);
  /*
   * The classic controlled-input bug: a cleared `<input type="date">` yields '', which is not a FHIR
   * date, and `gender` has a required binding. Silent until a validating server rejects it.
   */
  check('a blank birth date is absent, not empty', !('birthDate' in bare), JSON.stringify(bare));
  check('a blank gender is absent, not empty', !('gender' in bare));

  check('splitName takes the last token as family', splitName('Jane Citizen').family === 'Citizen');
  check('splitName keeps the rest as given', splitName('Jane Alexandra Citizen').given === 'Jane Alexandra');
  check('a single token becomes the family name', splitName('Prince').family === 'Prince');
  check('an empty name yields empty parts', splitName('   ').family === '');

  console.log('\n--- nobody by that name, to begin with ---');
  const before = await searchPatients(WRITE_SERVER, FAMILY, 5);
  check('the search finds nobody', before.resources.length === 0, `${before.resources.length} found`);

  console.log('\n--- a nameless patient is refused before any network call ---');
  let refused = false;
  try {
    await createPatient(WRITE_SERVER, { family: '   ' });
  } catch {
    refused = true;
  }
  check('createPatient rejects a blank family name', refused);
  check(
    'and wrote nothing',
    (await searchPatients(WRITE_SERVER, FAMILY, 5)).resources.length === 0
  );

  console.log('\n--- create them ---');
  const { reference, patient } = await createPatient(WRITE_SERVER, {
    family: FAMILY,
    given: GIVEN,
    birthDate: BIRTH_DATE,
    gender: 'female'
  });
  created.push({ type: 'Patient', id: patient.id! });
  console.log(`  ${reference}`);
  check('a usable reference comes back', reference === `Patient/${patient.id}`);
  check('it displays as the typed name', patientDisplay(patient) === `${GIVEN} ${FAMILY}`, patientDisplay(patient));

  const stored = await read<Patient>('Patient', patient.id!);
  check('the family name survived storage', stored.name?.[0]?.family === FAMILY);
  check('the given names survived', (stored.name?.[0]?.given ?? []).join(' ') === GIVEN);
  check('the birth date survived', stored.birthDate === BIRTH_DATE);
  check('the gender survived', stored.gender === 'female');
  check('it was a create, not an update', stored.meta?.versionId === '1', stored.meta?.versionId);
  check('describePatient renders it', describePatient(stored).includes(BIRTH_DATE), describePatient(stored));

  /*
   * The assertion this whole check exists for, after the create itself.
   *
   * It repeats the *identical* search that came back empty a moment ago, on purpose. The default
   * server sits behind a caching proxy that stores empty search responses, so a naive repeat replays
   * "nobody by that name" about the patient just created — which is what makes `searchPatients` force
   * revalidation. Varying the query to dodge the cache would test nothing anybody experiences.
   */
  console.log('\n--- and the picker can now find them, on the same search that just came back empty ---');
  const after = await searchPatients(WRITE_SERVER, FAMILY, 5);
  check('exactly one match', after.resources.length === 1, `${after.resources.length} found`);
  check('and it is the one just created', after.resources[0]?.id === patient.id);

  console.log('\n--- which is the point: the answers can now be filed ---');
  const answers: QuestionnaireResponse = {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    questionnaire: CANONICAL,
    item: [{ linkId: 'q1', text: 'Smoking status', answer: [{ valueString: 'never' }] }]
  };

  const [filed] = await submitResponse({
    response: { ...answers, subject: { reference, display: patientDisplay(patient) } },
    responseServerUrl: WRITE_SERVER
  });
  check('the write succeeds', !!filed.responseId, filed.error);
  if (filed.responseId) {
    created.push({ type: 'QuestionnaireResponse', id: filed.responseId });
    const readBack = await read<QuestionnaireResponse>('QuestionnaireResponse', filed.responseId);
    check('the subject is the new patient', readBack.subject?.reference === reference);
    check('and carries the name this server holds', readBack.subject?.display === patientDisplay(patient));
  }

  /*
   * The control. Without it the check above could pass because the server quietly stopped enforcing
   * referential integrity, in which case creating the patient achieved nothing.
   */
  console.log('\n--- the control: an unresolvable subject is still rejected ---');
  const [stranger] = await submitResponse({
    response: { ...answers, subject: { reference: 'Patient/does-not-exist' } },
    responseServerUrl: WRITE_SERVER
  });
  if (stranger.responseId) {
    created.push({ type: 'QuestionnaireResponse', id: stranger.responseId });
  }
  check(
    'it is refused',
    !stranger.responseId,
    'if this passes, the server is not enforcing integrity and the check above proves nothing'
  );
  check('and says why', (stranger.error ?? '').includes('does-not-exist'), stranger.error);

  console.log('\n--- and nothing else was created along the way ---');
  const finalCount = await searchPatients(WRITE_SERVER, FAMILY, 5);
  check('still exactly one patient', finalCount.resources.length === 1, `${finalCount.resources.length} found`);

  const leaked = await fetch(
    `${FORMS_SERVER}/Patient?name=${encodeURIComponent(FAMILY)}&_total=accurate`,
    { headers: { Accept: 'application/fhir+json' } }
  );
  const leakedBundle = (await leaked.json()) as { total?: number; entry?: unknown[] };
  check(
    'nothing reached the forms server',
    (leakedBundle.entry ?? []).length === 0,
    'the read-only catalogue must never receive patient data'
  );
} finally {
  console.log('\n--- cleanup ---');
  // Reverse dependency order: a Patient with a QuestionnaireResponse pointing at it will not delete.
  for (const { type, id } of created.reverse()) {
    const response = await fetch(`${WRITE_SERVER}/${type}/${id}`, { method: 'DELETE' });
    if (response.ok) {
      console.log(`  deleted ${type}/${id}`);
    } else {
      failures++;
      console.log(`  COULD NOT DELETE ${type}/${id} — ${response.status}`);
    }
  }
}

console.log(failures === 0 ? `\n${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
