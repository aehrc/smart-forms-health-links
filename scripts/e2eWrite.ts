/**
 * Live end-to-end check of the one-shot write channel (channel D), minus the UI.
 *
 *   requester: pick a form -> pre-allocate a write slot -> Bundle{Questionnaire, Task} -> JWE
 *                          -> POST /Binary -> shlink:/
 *   filler:    GET the blob -> decrypt -> read the write descriptor
 *                          -> PUT the answers into the slot, conditionally
 *                          -> PUT again, and be REFUSED
 *   requester: poll the slot -> review -> POST /QuestionnaireResponse
 *
 * The second PUT is the point of the whole exercise. Everything else here is machinery that other
 * checks already cover; what cannot be covered offline is whether a real FHIR server actually
 * enforces `If-Match`, and therefore whether "once" is true. A server that accepted the second write
 * would make the channel's central claim false, so this fails loudly rather than warning.
 *
 * The forms server is read ONLY. Everything written goes to `SHL_WRITE_SERVER` and is deleted again
 * afterwards.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-write
 */
import { fhirBinaryBlobStore } from "../src/fhir/blobStore";
import {
  fetchQuestionnaireByCanonical,
  searchQuestionnaires,
} from "../src/fhir/formsServer";
import { resolveDestinations, submitResponse } from "../src/fhir/submit";
import {
  buildRequestBundle,
  buildWriteResponse,
  isRequestBundle,
  parseRequestBundle,
  questionnaireCanonicalOf,
} from "../src/link/exchange";
import { parseReturnChannels, writeSlotId } from "../src/link/replyDescriptor";
import { shlCodec } from "../src/link/shlCodec";
import {
  createWriteSlot,
  pollWriteSlot,
  putResponseToSlot,
} from "../src/link/writeSlot";

import type { Questionnaire } from "fhir/r4";

const FORMS_SERVER = "https://smartforms.csiro.au/api/fhir";
const BASE_URL = "https://links.example.org";

const WRITE_SERVER = process.env.SHL_WRITE_SERVER;

if (!WRITE_SERVER) {
  console.log(
    "Skipped: set SHL_WRITE_SERVER to a FHIR server this test may write to.\n" +
      "  It creates a Binary and two QuestionnaireResponses, and cleans up after itself.\n" +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      "  SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-write",
  );
  process.exit(0);
}

if (WRITE_SERVER.replace(/\/+$/, "") === FORMS_SERVER) {
  console.error(
    `Refusing to run: SHL_WRITE_SERVER is the forms server (${FORMS_SERVER}).\n` +
      "That server is a read-only catalogue of questionnaires; writing test data into it pollutes a\n" +
      "shared resource other people search.",
  );
  process.exit(1);
}

let failures = 0;
let total = 0;

function check(name: string, condition: boolean, detail = "") {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

const created: string[] = [];

console.log(`forms server (read only): ${FORMS_SERVER}`);
console.log(`write server:            ${WRITE_SERVER}\n`);

// ---------------------------------------------------------------------------
console.log(
  "--- requester: mint a request that carries a write capability ---",
);

const catalogue = await searchQuestionnaires(FORMS_SERVER, "", 100);
const listed = catalogue.find(
  (candidate) => !!candidate.url && (candidate.item?.length ?? 0) > 0,
);
if (!listed?.url) {
  console.error(
    "No questionnaire with a canonical url was found on the forms server.",
  );
  process.exit(1);
}

const questionnaire: Questionnaire = await fetchQuestionnaireByCanonical(
  FORMS_SERVER,
  listed.url,
);
const canonical = questionnaireCanonicalOf(questionnaire);
console.log(
  `  form: ${questionnaire.title ?? questionnaire.id} (${canonical})`,
);

const requestId = crypto.randomUUID();
const slot = await createWriteSlot(WRITE_SERVER, {
  questionnaireCanonical: canonical,
  requestId,
});
created.push(slot.writeUrl);

check(
  "slot/urlIsAbsolute",
  /^https:\/\/.+\/QuestionnaireResponse\/[^/]+$/.test(slot.writeUrl),
  slot.writeUrl,
);
check(
  "slot/etagIsVersioned",
  /^W\/"[^"]+"$/.test(slot.writeEtag),
  slot.writeEtag,
);
check(
  "slot/tokenIsRandom",
  slot.writeToken.length >= 40,
  `${slot.writeToken.length} chars`,
);

const pendingBefore = await pollWriteSlot(slot.writeUrl);
check(
  "slot/startsPending",
  pendingBefore.status === "pending",
  pendingBefore.status,
);

const { bundle } = buildRequestBundle(questionnaire, {
  requestId,
  subjectDisplay: "Jane Citizen",
  requesterDisplay: "Parkview Medical Centre",
  writeDescriptor: {
    writeUrl: slot.writeUrl,
    writeMethod: "PUT",
    writeEtag: slot.writeEtag,
    writeToken: slot.writeToken,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  },
});

const blobStore = fhirBinaryBlobStore(WRITE_SERVER);
const link = await shlCodec.encode(
  { bundle, label: questionnaire.title },
  { baseUrl: BASE_URL, blobStore },
);
const blobUrl = JSON.parse(
  Buffer.from(link.split("shlink:/", 2)[1], "base64url").toString("utf8"),
).url as string;
created.push(blobUrl);

check(
  "link/hidesTheToken",
  !link.includes(slot.writeToken),
  "inspecting a link without its key must reveal no slot and no capability",
);
check("link/hidesTheSlotUrl", !link.includes(slot.writeUrl.split("/").pop()!));

// ---------------------------------------------------------------------------
console.log("\n--- filler: open the link and write the answers ---");

const decoded = await shlCodec.decode(link);
check("filler/opensTheInvitation", isRequestBundle(decoded.bundle));

const received = parseRequestBundle(decoded.bundle);
const channels = parseReturnChannels(received.task);

check("filler/seesTheWriteChannel", channels.write !== undefined);
check("filler/seesTheSameSlot", channels.write?.writeUrl === slot.writeUrl);
check("filler/seesTheEtag", channels.write?.writeEtag === slot.writeEtag);
check("filler/seesTheToken", channels.write?.writeToken === slot.writeToken);

const answers = buildWriteResponse(
  {
    resourceType: "QuestionnaireResponse",
    id: "the-fillers-own-local-id",
    status: "in-progress",
    questionnaire: canonical,
    subject: {
      reference: "Patient/a-vault-key-that-resolves-nowhere",
      display: "Jane Citizen",
    },
    item: [
      {
        linkId: received.questionnaire.item?.[0]?.linkId ?? "1",
        text: "e2e",
        answer: [{ valueString: "e2e" }],
      },
    ],
  },
  { requestTask: received.task },
);

const first = await putResponseToSlot(channels.write!, answers);
check("write/firstSucceeds", first.status === "written", first.status);

/*
 * The check the whole channel rests on. A second write must be refused by the server's own
 * optimistic locking — if this passes, "once" is a property of the wire and not a promise.
 */
const second = await putResponseToSlot(channels.write!, answers);
check(
  "write/secondIsRefused",
  second.status === "taken",
  second.status === "taken"
    ? second.detail
    : `got "${second.status}" — the slot is NOT single-use`,
);

// ---------------------------------------------------------------------------
console.log("\n--- requester: collect, review, and write to the record ---");

const collected = await pollWriteSlot(slot.writeUrl);
check("collect/isReady", collected.status === "ready", collected.status);

if (collected.status === "ready") {
  check("collect/isCompleted", collected.response.status === "completed");
  check(
    "collect/keepsPatientAsserted",
    (collected.response.meta?.security ?? []).some(
      (coding) => coding.code === "PATAST",
    ),
    "without this, answers typed by a patient read as answers a clinician recorded",
  );
  check(
    "collect/carriesTheSlotId",
    collected.response.id === writeSlotId(slot.writeUrl),
    "a FHIR update writes to the id in the URL, so this is what came back",
  );
  check(
    "collect/correlatesToTheRequest",
    collected.response.identifier?.value === `urn:uuid:${requestId}`,
    "there is no Task on this channel, so the identifier is what ties answers to the request",
  );
  check(
    "collect/subjectDoesNotResolveHere",
    collected.response.subject?.reference === undefined &&
      collected.response.subject?.display === "Jane Citizen",
    "the name survives; the filler’s own patient id deliberately does not travel",
  );

  const destinations = resolveDestinations({
    questionnaire,
    responseServerUrl: WRITE_SERVER,
  });
  const results = await submitResponse({
    response: collected.response,
    questionnaire,
    responseServerUrl: WRITE_SERVER,
  });

  check("record/destinationResolved", destinations[0] === WRITE_SERVER);
  check(
    "record/written",
    results[0]?.responseId !== undefined,
    results[0]?.error ?? "",
  );
  check(
    "record/isANewResource",
    results[0]?.responseId !== writeSlotId(slot.writeUrl),
    "the slot id belongs to the transport slot, never to the record",
  );

  for (const result of results) {
    if (result.responseId) {
      created.push(
        `${WRITE_SERVER}/QuestionnaireResponse/${result.responseId}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n--- cleanup ---");

let deleted = 0;
for (const url of [...created].toReversed()) {
  try {
    const response = await fetch(url, { method: "DELETE" });
    if (response.ok) {
      deleted++;
    } else {
      console.log(
        `  could not delete ${url} — ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    console.log(
      `  could not delete ${url} — ${error instanceof Error ? error.message : error}`,
    );
  }
}

check(
  "cleanup/allRemoved",
  deleted === created.length,
  `${deleted}/${created.length} deleted`,
);

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
