/**
 * Live end-to-end check of the SMART Health Link round trip, minus the UI.
 *
 *   requester: pick a form -> Bundle{Questionnaire, Task} -> JWE -> POST /Binary -> shlink:/
 *   filler:    GET the blob -> decrypt -> fill -> Bundle{QuestionnaireResponse, Task}
 *   requester: review -> POST /QuestionnaireResponse + POST /Task
 *
 * This WRITES to the public forms server (a Binary, a QuestionnaireResponse and a Task), so it is
 * opt-in and cleans up the Binary afterwards.
 *
 *   npm run check:e2e-shl
 */
import type { Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import { fetchQuestionnaireByCanonical, searchQuestionnaires } from '../src/fhir/formsServer';
import { fhirBinaryBlobStore } from '../src/fhir/blobStore';
import { resolveDestinations, submitResponse } from '../src/fhir/submit';
import { shlCodec } from '../src/link/shlCodec';
import { questionnaireCanonical } from '../src/link/codec';
import {
  buildRequestBundle,
  buildResponseBundle,
  isRequestBundle,
  parseRequestBundle,
  parseResponseBundle,
  taskCorrelationId
} from '../src/link/exchange';
import { chooseErrorCorrectionLevel } from '../src/link/qrCapacity';

const FORMS_SERVER = 'https://smartforms.csiro.au/api/fhir';
const BASE_URL = 'https://links.example.org';

let failures = 0;
let total = 0;

function check(name: string, condition: boolean, detail = '') {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const created: string[] = [];

console.log(`forms server: ${FORMS_SERVER}\n`);
console.log('--- requester: build the request ---');

// Pick a small-ish renderable form with a canonical url.
const questionnaires = await searchQuestionnaires(FORMS_SERVER, '', 100);
const picked = questionnaires.find((q) => q.url && q.id && (q.item?.length ?? 0) > 0);
if (!picked) {
  console.error('No suitable questionnaire found.');
  process.exit(1);
}
console.log(`  form: ${picked.title ?? picked.id}`);
console.log(`        ${picked.url}${picked.version ? `|${picked.version}` : ''}`);

/*
 * The forms server enforces referential integrity (HAPI-1094), so a subject must actually exist
 * before a QuestionnaireResponse can name it. Create one to exercise the realistic path; the
 * unresolvable-subject case is asserted separately at the end.
 */
const patientResponse = await fetch(`${FORMS_SERVER}/Patient`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
  body: JSON.stringify({
    resourceType: 'Patient',
    name: [{ family: 'Test', given: ['SHL E2E'] }]
  })
});
const patientId = ((await patientResponse.json()) as { id?: string }).id;
if (!patientId) {
  console.error('Could not create a test Patient.');
  process.exit(1);
}
const subjectReference = `Patient/${patientId}`;
console.log(`  subject: ${subjectReference} (created for this run)`);

const { bundle: requestBundle, task: requestTask } = buildRequestBundle(picked, {
  subjectReference
});

check('request/isRequestBundle', isRequestBundle(requestBundle));
check('request/hasCorrelationId', taskCorrelationId(requestTask) !== undefined, taskCorrelationId(requestTask));

const questionnaireBytes = Buffer.byteLength(JSON.stringify(picked));
const blobStore = fhirBinaryBlobStore(FORMS_SERVER);

const requestLink = await shlCodec.encode(
  { bundle: requestBundle, label: picked.title ?? 'Questionnaire' },
  { baseUrl: BASE_URL, blobStore }
);

const binaryUrl = JSON.parse(
  Buffer.from(
    requestLink.slice(requestLink.indexOf('shlink:/') + 'shlink:/'.length),
    'base64url'
  ).toString()
).url as string;
created.push(binaryUrl);

console.log(`  questionnaire: ${questionnaireBytes} bytes  ->  link: ${Buffer.byteLength(requestLink)} bytes`);
check('request/blobHostedOnFormsServer', binaryUrl.startsWith(`${FORMS_SERVER}/Binary/`), binaryUrl);
check(
  'request/blobUrlIsHttps',
  binaryUrl.startsWith('https://'),
  'the Location header reports http:// and the wrong path, so the URL must be rebuilt'
);
check('request/linkFitsQr', chooseErrorCorrectionLevel(requestLink) !== null, `level ${chooseErrorCorrectionLevel(requestLink)}`);
check(
  'request/linkIsTinyDespiteBigForm',
  Buffer.byteLength(requestLink) < 500 && questionnaireBytes > 2000,
  `${questionnaireBytes} -> ${Buffer.byteLength(requestLink)}`
);

// The hosted blob must be opaque to anyone without the key.
const rawBlob = await (await fetch(binaryUrl)).text();
check('request/blobIsJwe', rawBlob.split('.').length === 5, `${rawBlob.length} bytes`);
check('request/blobLeaksNothing', !rawBlob.includes('Questionnaire') && !rawBlob.includes('linkId'));

console.log('\n--- filler: open the request and answer it ---');

const openedRequest = await shlCodec.decode(requestLink);
check('filler/decodesRequest', isRequestBundle(openedRequest.bundle));

const parsedRequest = parseRequestBundle(openedRequest.bundle);
check('filler/questionnaireMatches', parsedRequest.questionnaire.url === picked.url);
check(
  'filler/questionnaireArrivedWhole',
  JSON.stringify(parsedRequest.questionnaire) === JSON.stringify(picked),
  'no forms-server access was needed'
);
check(
  'filler/taskCorrelationSurvives',
  taskCorrelationId(parsedRequest.task) === taskCorrelationId(requestTask)
);
check('filler/taskStatus', parsedRequest.task.status === 'requested', parsedRequest.task.status);
check('filler/subjectSurvives', parsedRequest.task.for?.reference === subjectReference);

// Answer the first item.
const firstItem = parsedRequest.questionnaire.item?.[0];
const answered: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  questionnaire: questionnaireCanonicalOf(parsedRequest.questionnaire),
  subject: parsedRequest.task.for,
  authored: new Date().toISOString(),
  item: firstItem
    ? [{ linkId: firstItem.linkId, text: firstItem.text, answer: [{ valueString: 'e2e test' }] }]
    : []
};

const { bundle: responseBundle, task: responseTask } = buildResponseBundle(
  answered,
  parsedRequest.task
);

check('filler/responseTaskCompleted', responseTask?.status === 'completed', responseTask?.status);
check(
  'filler/responseTaskPointsAtResponse',
  responseTask?.output?.[0]?.valueReference?.reference?.startsWith('urn:uuid:') === true
);
check('filler/noDanglingFocus', responseTask?.focus === undefined, 'focus dropped with the Questionnaire');
check(
  'filler/canonicalPreservedInInput',
  responseTask?.input?.some((input) => input.valueCanonical) === true
);
check(
  'filler/responseCarriesNoQuestionnaire',
  Buffer.byteLength(JSON.stringify(responseBundle)) < questionnaireBytes,
  `${Buffer.byteLength(JSON.stringify(responseBundle))} bytes`
);

console.log('\n--- requester: review and accept ---');

const parsedResponse = parseResponseBundle(responseBundle);
check('review/notARequest', !isRequestBundle(responseBundle));
check(
  'review/correlationMatches',
  taskCorrelationId(parsedResponse.task) === taskCorrelationId(requestTask),
  taskCorrelationId(parsedResponse.task)
);

// The requester resolves the form from the canonical, exactly as the UI does.
const resolved = await fetchQuestionnaireByCanonical(
  FORMS_SERVER,
  questionnaireCanonical(parsedResponse.response)
);
check('review/resolvesQuestionnaire', resolved.url === picked.url, resolved.url);

const destinations = resolveDestinations({ questionnaire: resolved, formsServerUrl: FORMS_SERVER });
check('review/destination', destinations.length === 1, destinations.join(', '));

const results = await submitResponse({
  response: parsedResponse.response,
  task: parsedResponse.task,
  questionnaire: resolved,
  formsServerUrl: FORMS_SERVER
});

for (const result of results) {
  check(
    'review/saved',
    !!result.responseId,
    result.error ?? `QuestionnaireResponse/${result.responseId} · Task/${result.taskId}`
  );

  if (result.responseId) {
    // Confirm it really landed, and that the Task points at the real id rather than a urn:uuid.
    const stored = (await (
      await fetch(`${FORMS_SERVER}/QuestionnaireResponse/${result.responseId}`, {
        headers: { Accept: 'application/fhir+json' }
      })
    ).json()) as QuestionnaireResponse;
    check('review/storedRoundTrip', stored.item?.[0]?.answer?.[0]?.valueString === 'e2e test');

    if (result.taskId) {
      const storedTask = (await (
        await fetch(`${FORMS_SERVER}/Task/${result.taskId}`, {
          headers: { Accept: 'application/fhir+json' }
        })
      ).json()) as { output?: { valueReference?: { reference?: string } }[] };
      check(
        'review/taskLinksRealResponseId',
        storedTask.output?.[0]?.valueReference?.reference ===
          `QuestionnaireResponse/${result.responseId}`,
        storedTask.output?.[0]?.valueReference?.reference
      );
    }
  }
}

console.log('\n--- failure mode: a subject the requester does not know ---');

/*
 * A response from a third-party app will often name a patient that does not exist on the requester's
 * server. The write must fail with a message the reviewer can act on, not a bare 400 — and it must
 * NOT be papered over by silently dropping the subject, which would lose who the answers are about.
 */
const strangerResults = await submitResponse({
  response: { ...parsedResponse.response, subject: { reference: 'Patient/does-not-exist' } },
  questionnaire: resolved,
  formsServerUrl: FORMS_SERVER
});

const strangerError = strangerResults[0]?.error ?? '';
check('stranger/rejected', !strangerResults[0]?.responseId);
check(
  'stranger/errorIsActionable',
  strangerError.includes('does-not-exist') && strangerError.includes('subject'),
  strangerError
);

// Tidy up the Binary and the test Patient; the QuestionnaireResponse and Task are left as evidence.
for (const url of created) {
  await fetch(url, { method: 'DELETE' }).catch(() => undefined);
}
await fetch(`${FORMS_SERVER}/${subjectReference}`, { method: 'DELETE' }).catch(() => undefined);
console.log(`\ncleaned up ${created.length} Binary blob(s) and the test Patient`);

console.log(
  failures === 0 ? `\nAll ${total} checks passed.` : `\n${failures} of ${total} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);

function questionnaireCanonicalOf(questionnaire: Questionnaire): string {
  return questionnaire.version ? `${questionnaire.url}|${questionnaire.version}` : questionnaire.url!;
}
