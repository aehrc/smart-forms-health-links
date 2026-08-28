/**
 * Live end-to-end check that a write slot nominated by the launching EHR is the one used.
 *
 *   EHR:       allocate a QuestionnaireResponse slot on its own server
 *              -> hand its address and a capability to the app through the launch context
 *   requester: read that nomination -> Bundle{Questionnaire, Task} -> JWE
 *              -> the invitation must name the EHR's slot, and nothing of our own
 *   filler:    open the link -> read the descriptor -> PUT the answers to the EHR's slot
 *   EHR:       read its own slot and find the answers, under the identifier it chose
 *
 * The point of the exercise is the negative half: with a nomination present, this app must allocate
 * NOTHING on its own blob store, and must use the EHR's `request_id` rather than minting one. Either
 * failure is silent in the UI and only visible on the record system that asked for the form — the
 * answers arrive somewhere it does not read, or under an identifier it cannot match.
 *
 * Mints via `nominatedWriteTarget` + `buildRequestBundle` + the codec rather than
 * `createRequestLink`, for the reason `e2ePopulate.ts` gives: that layer imports the renderer, which
 * ships a `.woff2` esbuild has no loader for. The decision under test was split into
 * `src/link/writeTarget.ts` precisely so it could be reached from here without that; the assertion
 * that a nomination suppresses self-minting is made against `usesNomination`, which is the flag
 * `createRequestLink` gates `createWriteSlot` on.
 *
 * `SHL_WRITE_SERVER` stands in for the EHR's server, and must be `https` and not loopback: the
 * address is carried in link content and `isSafeWriteUrl` refuses anything else, on the filler side
 * as well as at the launch. Everything written is deleted again afterwards.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-nominated-slot
 */
import type { Questionnaire } from 'fhir/r4';
import { fetchQuestionnaireByCanonical, searchQuestionnaires } from '../src/fhir/formsServer';
import { nominatedWriteSlotFrom } from '../src/auth/nominatedSlot';
import { nominatedWriteTarget } from '../src/link/writeTarget';
import { fhirBinaryBlobStore } from '../src/fhir/blobStore';
import { shlCodec } from '../src/link/shlCodec';
import {
  buildRequestBundle,
  buildWriteResponse,
  isRequestBundle,
  parseRequestBundle,
  questionnaireCanonicalOf
} from '../src/link/exchange';
import { parseReturnChannels } from '../src/link/replyDescriptor';
import { createWriteSlot, pollWriteSlot, putResponseToSlot } from '../src/link/writeSlot';

const FORMS_SERVER = 'https://smartforms.csiro.au/api/fhir';
const BASE_URL = 'https://links.example.org';

const WRITE_SERVER = process.env.SHL_WRITE_SERVER;

if (!WRITE_SERVER) {
  console.log(
    'Skipped: set SHL_WRITE_SERVER to a FHIR server this test may write to.\n' +
      '  It stands in for the launching EHR: the test allocates a slot on it, then checks that the\n' +
      '  invitation names that slot rather than one on our own blob store. Cleans up after itself.\n' +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      '  SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-nominated-slot'
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

const created: string[] = [];

console.log(`forms server (read only):  ${FORMS_SERVER}`);
console.log(`EHR server (nominated):    ${WRITE_SERVER}\n`);

// ---------------------------------------------------------------------------
console.log('--- the address itself: what a launch may and may not nominate ---');

check(
  'nominate/acceptsHttps',
  nominatedWriteSlotFrom('https://ehr.example.org/fhir/QuestionnaireResponse/abc', 'tok')?.url ===
    'https://ehr.example.org/fhir/QuestionnaireResponse/abc'
);
check('nominate/absentIsNull', nominatedWriteSlotFrom(undefined, undefined) === null);
check(
  'nominate/tokenIsOptional',
  nominatedWriteSlotFrom('https://ehr.example.org/fhir/QuestionnaireResponse/abc', undefined)
    ?.token === null,
  'an EHR may leave its own slot unauthenticated; that is its call, not ours'
);
check(
  'nominate/refusesPlainHttp',
  nominatedWriteSlotFrom('http://ehr.example.org/fhir/QuestionnaireResponse/abc', 'tok') === null,
  'answers must not be sent in the clear'
);
check(
  'nominate/refusesLoopback',
  nominatedWriteSlotFrom('https://localhost/fhir/QuestionnaireResponse/abc', 'tok') === null,
  'nothing legitimate asks a filler to post answers to the filler’s own device'
);

// ---------------------------------------------------------------------------
console.log('\n--- the decision: what a nomination does to the request ---');

const noLaunch = nominatedWriteTarget(null, undefined);
check('decide/noLaunchMintsItsOwn', noLaunch.requestId === null && !noLaunch.usesNomination);
check('decide/noLaunchOffersNoDescriptor', noLaunch.writeDescriptor === undefined);

const sample = nominatedWriteTarget(
  {
    nominatedWriteSlot: nominatedWriteSlotFrom(
      'https://ehr.example.org/fhir/QuestionnaireResponse/abc',
      'a-capability'
    ),
    nominatedRequestId: 'the-ehrs-own-id'
  },
  1_800_000_000
);
check('decide/adoptsTheEhrIdentifier', sample.requestId === 'the-ehrs-own-id');
check(
  'decide/suppressesSelfMinting',
  sample.usesNomination,
  'this is the flag createRequestLink gates createWriteSlot on, so nothing is allocated on our store'
);
check('decide/namesTheEhrSlot', sample.writeDescriptor?.writeUrl === 'https://ehr.example.org/fhir/QuestionnaireResponse/abc');
check('decide/passesTheCapability', sample.writeDescriptor?.writeToken === 'a-capability');
check(
  'decide/sendsNoEtag',
  sample.writeDescriptor?.writeEtag === undefined,
  'the EHR allocated the resource and enforces single-use however it likes; a version we invented ' +
    'would either be wrong or forbid the write outright'
);
check(
  'decide/unsafeAddressOffersNoChannel',
  nominatedWriteTarget(
    {
      nominatedWriteSlot: nominatedWriteSlotFrom('http://ehr.example.org/fhir/x/1', 'tok'),
      nominatedRequestId: 'id'
    },
    undefined
  ).writeDescriptor === undefined,
  'refused at the launch, so the invitation honestly offers no write channel'
);

// ---------------------------------------------------------------------------
console.log('\n--- EHR: allocate a slot, and mint an invitation naming it ---');

const catalogue = await searchQuestionnaires(FORMS_SERVER, '', 100);
const listed = catalogue.find((candidate) => !!candidate.url && (candidate.item?.length ?? 0) > 0);
if (!listed?.url) {
  console.error('No questionnaire with a canonical url was found on the forms server.');
  process.exit(1);
}

const questionnaire: Questionnaire = await fetchQuestionnaireByCanonical(FORMS_SERVER, listed.url);
const canonical = questionnaireCanonicalOf(questionnaire);
console.log(`  form: ${questionnaire.title ?? questionnaire.id} (${canonical})`);

/* The EHR's own identifier for the request, chosen before it launched us. */
const ehrRequestId = crypto.randomUUID();
const ehrSlot = await createWriteSlot(WRITE_SERVER, {
  questionnaireCanonical: canonical,
  requestId: ehrRequestId
});
created.push(ehrSlot.writeUrl);
console.log(`  EHR slot: ${ehrSlot.writeUrl}`);

/*
 * How many QuestionnaireResponses the blob store holds before the invitation is minted. The
 * nomination path must not add one — that is the live half of the self-minting assertion above.
 */
async function countResponses(): Promise<number> {
  const response = await fetch(`${WRITE_SERVER}/QuestionnaireResponse?_summary=count`, {
    headers: { Accept: 'application/fhir+json' }
  });
  const body: unknown = await response.json();

  // A count the server declined to give is reported as -1 rather than 0: two equal counts are the
  // assertion below, and a silent 0 on both sides would pass it without having measured anything.
  if (body && typeof body === 'object' && 'total' in body && typeof body.total === 'number') {
    return body.total;
  }
  return -1;
}

const responsesBefore = await countResponses();

const session = {
  nominatedWriteSlot: nominatedWriteSlotFrom(ehrSlot.writeUrl, ehrSlot.writeToken),
  nominatedRequestId: ehrRequestId
};
const target = nominatedWriteTarget(session, Math.floor(Date.now() / 1000) + 86400);

check('launch/slotSurvivedTheLaunch', session.nominatedWriteSlot?.url === ehrSlot.writeUrl);
check('launch/targetsTheEhrSlot', target.writeDescriptor?.writeUrl === ehrSlot.writeUrl);

const { bundle, task } = buildRequestBundle(questionnaire, {
  requestId: target.requestId ?? crypto.randomUUID(),
  subjectDisplay: 'Jane Citizen',
  requesterDisplay: 'Parkview Medical Centre',
  ...(target.writeDescriptor ? { writeDescriptor: target.writeDescriptor } : {})
});

const blobStore = fhirBinaryBlobStore(WRITE_SERVER);
const link = await shlCodec.encode(
  { bundle, label: questionnaire.title },
  { baseUrl: BASE_URL, blobStore }
);
const blobUrl = JSON.parse(
  Buffer.from(link.split('shlink:/')[1], 'base64url').toString('utf8')
).url as string;
created.push(blobUrl);

const responsesAfter = await countResponses();
check(
  'mint/allocatedNothingOfItsOwn',
  responsesAfter === responsesBefore,
  `${responsesBefore} before, ${responsesAfter} after — a nomination must not also mint a slot`
);
check(
  'mint/carriesTheEhrIdentifier',
  task.identifier?.some((identifier) => identifier.value === `urn:uuid:${ehrRequestId}`) === true,
  'minting our own leaves every returned response correlating to nothing on the EHR'
);
check('link/hidesTheToken', !link.includes(ehrSlot.writeToken));

// ---------------------------------------------------------------------------
console.log('\n--- filler: open the link and write to the EHR’s slot ---');

const decoded = await shlCodec.decode(link);
check('filler/opensTheInvitation', isRequestBundle(decoded.bundle));

const received = parseRequestBundle(decoded.bundle);
const channels = parseReturnChannels(received.task);

check('filler/seesTheWriteChannel', channels.write !== undefined);
check(
  'filler/seesTheEhrSlot',
  channels.write?.writeUrl === ehrSlot.writeUrl,
  channels.write?.writeUrl ?? '(none)'
);
check('filler/seesTheEhrToken', channels.write?.writeToken === ehrSlot.writeToken);
check('filler/sendsNoIfMatch', channels.write?.writeEtag === undefined);

const answers = buildWriteResponse(
  {
    resourceType: 'QuestionnaireResponse',
    id: 'the-fillers-own-local-id',
    status: 'in-progress',
    questionnaire: canonical,
    subject: { reference: 'Patient/resolves-only-on-the-fillers-device', display: 'Jane Citizen' },
    item: [
      {
        linkId: received.questionnaire.item?.[0]?.linkId ?? '1',
        text: 'e2e',
        answer: [{ valueString: 'e2e' }]
      }
    ]
  },
  { requestTask: received.task }
);

const written = await putResponseToSlot(channels.write!, answers);
check('write/reachesTheEhrSlot', written.status === 'written', written.status);

// ---------------------------------------------------------------------------
console.log('\n--- EHR: read its own slot ---');

const collected = await pollWriteSlot(ehrSlot.writeUrl);
check('collect/isReady', collected.status === 'ready', collected.status);

if (collected.status === 'ready') {
  check('collect/isCompleted', collected.response.status === 'completed');
  check(
    'collect/correlatesToTheEhrRequest',
    collected.response.identifier?.value === `urn:uuid:${ehrRequestId}`,
    'the identifier the EHR chose, back on the answers it asked for'
  );
  check(
    'collect/keepsPatientAsserted',
    (collected.response.meta?.security ?? []).some((coding) => coding.code === 'PATAST'),
    'without this, answers typed by a patient read as answers a clinician recorded'
  );
}

// ---------------------------------------------------------------------------
console.log('\n--- cleanup ---');

for (const url of created.reverse()) {
  const response = await fetch(url, { method: 'DELETE' });
  console.log(
    `  ${response.ok || response.status === 404 ? 'ok  ' : 'warn'}  DELETE ${url} -> ${response.status}`
  );
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
