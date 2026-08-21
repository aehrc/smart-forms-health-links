/**
 * Live end-to-end check of the SMART Health Link round trip, minus the UI.
 *
 *   requester: pick a form -> mint a reply slot -> Bundle{Questionnaire, Task} -> JWE
 *                          -> POST /Binary -> shlink:/
 *   filler:    GET the blob -> decrypt -> fill, then return the answers BOTH ways:
 *                (a) as a link, and
 *                (b) encrypted to the requester's key, PUT into the reply slot
 *   requester: poll the slot -> decrypt -> review -> POST /QuestionnaireResponse + /Task + /Provenance
 *
 * The forms server is read ONLY (search, and resolve-by-canonical). Everything this test writes —
 * Binary, Patient, QuestionnaireResponse, Task, Provenance — goes to `SHL_WRITE_SERVER`, and is deleted
 * again afterwards in reverse dependency order.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-shl
 */
import { JOSE_CONTENT_TYPE, fhirBinaryBlobStore } from "../src/fhir/blobStore";
import { searchPublishedRequests } from "../src/fhir/ehrServer";
import {
  fetchQuestionnaireByCanonical,
  searchQuestionnaires,
} from "../src/fhir/formsServer";
import {
  publishRequestTask,
  resolveDestinations,
  submitResponse,
} from "../src/fhir/submit";
import { findRequestForTask, mergeSentRequests } from "../src/lib/sentRequests";
import { encodeUtf8, decodeUtf8 } from "../src/link/binary";
import { questionnaireCanonical } from "../src/link/codec";
import {
  PATIENT_ASSERTED_SECURITY,
  buildReplyBundle,
  buildRequestBundle,
  buildResponseBundle,
  isRequestBundle,
  parseRequestBundle,
  parseResponseBundle,
  questionnaireCanonicalOf,
  taskCorrelationId,
} from "../src/link/exchange";
import { encryptJwe, generateKey, keyToBase64Url } from "../src/link/jwe";
import { chooseErrorCorrectionLevel } from "../src/link/qrCapacity";
import {
  decryptReplyJwe,
  encryptReplyJwe,
  generateReplyKeyPair,
} from "../src/link/replyCrypto";
import { parseReplyDescriptor } from "../src/link/replyDescriptor";
import { createReplySlot, pollReply, putReply } from "../src/link/replySlot";
import { shlCodec } from "../src/link/shlCodec";

import type { QuestionnaireResponse, Task } from "fhir/r4";

const FORMS_SERVER = "https://smartforms.csiro.au/api/fhir";
const BASE_URL = "https://links.example.org";

/**
 * Where this test is allowed to write. Never the forms server — that is a read-only catalogue, and
 * an earlier version of this script left test Patients, Tasks and QuestionnaireResponses in it.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-shl
 */
const WRITE_SERVER = process.env.SHL_WRITE_SERVER;

if (!WRITE_SERVER) {
  console.log(
    "Skipped: set SHL_WRITE_SERVER to a FHIR server this test may write to.\n" +
      "  It creates a Binary, a Patient, a QuestionnaireResponse and a Task, and cleans up after itself.\n" +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      "  SHL_WRITE_SERVER=https://your-server/fhir npm run check:e2e-shl",
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
console.log("--- requester: build the request ---");

// Pick a small-ish renderable form with a canonical url.
const questionnaires = await searchQuestionnaires(FORMS_SERVER, "", 100);
const picked = questionnaires.find(
  (q) => q.url && q.id && (q.item?.length ?? 0) > 0,
);
if (!picked) {
  console.error("No suitable questionnaire found.");
  process.exit(1);
}
console.log(`  form: ${picked.title ?? picked.id}`);
console.log(
  `        ${picked.url}${picked.version ? `|${picked.version}` : ""}`,
);

/*
 * The forms server enforces referential integrity (HAPI-1094), so a subject must actually exist
 * before a QuestionnaireResponse can name it. Create one to exercise the realistic path; the
 * unresolvable-subject case is asserted separately at the end.
 */
const runId = crypto.randomUUID();

const patientResponse = await fetch(`${WRITE_SERVER}/Patient`, {
  method: "POST",
  headers: {
    "Content-Type": "application/fhir+json",
    Accept: "application/fhir+json",
  },
  body: JSON.stringify({
    resourceType: "Patient",
    /*
     * Unique per run. Some servers reject byte-identical creates outright
     * (`HAPI-2840: Can not create resource duplicating existing resource`), and a run-scoped
     * identifier also makes leftovers traceable if cleanup ever fails.
     */
    identifier: [{ system: "urn:smart-forms-health-links:e2e", value: runId }],
    name: [{ family: "Test", given: ["SHL E2E"] }],
  }),
});
const patientBody = await patientResponse.text();
let patientId: string | undefined;
try {
  patientId = (JSON.parse(patientBody) as { id?: string }).id;
} catch {
  // Fall through to the diagnostic below.
}

if (!patientId) {
  console.error(
    `Could not create a test Patient on ${WRITE_SERVER} ` +
      `(${patientResponse.status} ${patientResponse.statusText}).\n${patientBody.slice(0, 600)}`,
  );
  process.exit(1);
}
const subjectReference = `Patient/${patientId}`;
console.log(`  subject: ${subjectReference} (created for this run)`);

const questionnaireBytes = Buffer.byteLength(JSON.stringify(picked));
const blobStore = fhirBinaryBlobStore(WRITE_SERVER);

/*
 * Channel C is set up before the payload is built, because the slot URL and public key have to travel
 * *inside* the encrypted invitation — they cannot be added to a link that has already been sealed.
 */
const replyKeys = await generateReplyKeyPair();
const replySlotUrl = await createReplySlot(blobStore);
created.push(replySlotUrl);
console.log(`  reply slot: ${replySlotUrl}`);

const replyDescriptor = {
  replyUrl: replySlotUrl,
  replyMethod: "PUT" as const,
  publicJwk: replyKeys.publicJwk,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
};

const initialSlot = await pollReply(replySlotUrl);
check(
  "slot/startsPending",
  initialSlot.status === "pending",
  initialSlot.status,
);

const { bundle: requestBundle, task: requestTask } = buildRequestBundle(
  picked,
  {
    subjectReference,
    subjectDisplay: "SHL E2E Test",
    requesterDisplay: "E2E Practice",
    replyDescriptor,
  },
);

check("request/isRequestBundle", isRequestBundle(requestBundle));
check(
  "request/hasCorrelationId",
  taskCorrelationId(requestTask) !== undefined,
  taskCorrelationId(requestTask),
);
check(
  "request/focusIsCanonical",
  requestTask.focus?.reference === questionnaireCanonicalOf(picked) &&
    requestTask.focus?.type === "Questionnaire",
  requestTask.focus?.reference,
);
check(
  "request/addresseeIsReadable",
  requestTask.for?.display === "SHL E2E Test",
);
check(
  "request/senderIsReadable",
  requestTask.requester?.display === "E2E Practice",
);

const requestLink = await shlCodec.encode(
  { bundle: requestBundle, label: picked.title ?? "Questionnaire" },
  { baseUrl: BASE_URL, blobStore },
);

const binaryUrl = JSON.parse(
  Buffer.from(
    requestLink.slice(requestLink.indexOf("shlink:/") + "shlink:/".length),
    "base64url",
  ).toString(),
).url as string;
created.push(binaryUrl);

console.log(
  `  questionnaire: ${questionnaireBytes} bytes  ->  link: ${Buffer.byteLength(requestLink)} bytes`,
);
check(
  "request/blobHostedOnWriteServer",
  binaryUrl.startsWith(`${WRITE_SERVER}/Binary/`),
  binaryUrl,
);
check(
  "request/blobNotOnFormsServer",
  !binaryUrl.startsWith(FORMS_SERVER),
  "the catalogue must never be written to",
);
check(
  "request/blobUrlIsHttps",
  binaryUrl.startsWith("https://"),
  "the Location header reports http:// and the wrong path, so the URL must be rebuilt",
);
check(
  "request/linkFitsQr",
  chooseErrorCorrectionLevel(requestLink) !== null,
  `level ${chooseErrorCorrectionLevel(requestLink)}`,
);
check(
  "request/linkIsTinyDespiteBigForm",
  Buffer.byteLength(requestLink) < 500 && questionnaireBytes > 2000,
  `${questionnaireBytes} -> ${Buffer.byteLength(requestLink)}`,
);

// The hosted blob must be opaque to anyone without the key.
const rawBlob = await (await fetch(binaryUrl)).text();
check(
  "request/blobIsJwe",
  rawBlob.split(".").length === 5,
  `${rawBlob.length} bytes`,
);
check(
  "request/blobLeaksNothing",
  !rawBlob.includes("Questionnaire") && !rawBlob.includes("linkId"),
);

/*
 * The reply channel must be invisible to anyone holding the link but not its key. Inspecting a
 * `shlink:` string should reveal no slot to overwrite and no key to encrypt to.
 */
check(
  "request/linkHidesReplySlot",
  !requestLink.includes(replySlotUrl.split("/").pop()!) &&
    !requestLink.includes(replyKeys.publicJwk.x),
  "the descriptor lives only inside the encrypted payload",
);
check(
  "request/blobHidesPrivateKey",
  !rawBlob.includes(replyKeys.privateJwk.d),
  "the private key must never leave the requester",
);

console.log("\n--- filler: open the request and answer it ---");

const openedRequest = await shlCodec.decode(requestLink);
check("filler/decodesRequest", isRequestBundle(openedRequest.bundle));

const parsedRequest = parseRequestBundle(openedRequest.bundle);
check(
  "filler/questionnaireMatches",
  parsedRequest.questionnaire.url === picked.url,
);
check(
  "filler/questionnaireArrivedWhole",
  JSON.stringify(parsedRequest.questionnaire) === JSON.stringify(picked),
  "no forms-server access was needed",
);
check(
  "filler/taskCorrelationSurvives",
  taskCorrelationId(parsedRequest.task) === taskCorrelationId(requestTask),
);
check(
  "filler/taskStatus",
  parsedRequest.task.status === "requested",
  parsedRequest.task.status,
);
check(
  "filler/subjectSurvives",
  parsedRequest.task.for?.reference === subjectReference,
);

const openedDescriptor = parseReplyDescriptor(parsedRequest.task);
check("filler/readsReplyDescriptor", openedDescriptor !== undefined);
check(
  "filler/replySlotMatches",
  openedDescriptor?.replyUrl === replySlotUrl,
  openedDescriptor?.replyUrl,
);
check("filler/replyMethodIsPut", openedDescriptor?.replyMethod === "PUT");
check(
  "filler/replyKeyMatches",
  JSON.stringify(openedDescriptor?.publicJwk) ===
    JSON.stringify(replyKeys.publicJwk),
);
check(
  "filler/seesSender",
  parsedRequest.task.requester?.display === "E2E Practice",
);
check(
  "filler/seesAddressee",
  parsedRequest.task.for?.display === "SHL E2E Test",
);

// Answer the first item.
const firstItem = parsedRequest.questionnaire.item?.[0];
const answered: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: questionnaireCanonicalOf(parsedRequest.questionnaire),
  subject: parsedRequest.task.for,
  authored: new Date().toISOString(),
  item: firstItem
    ? [
        {
          linkId: firstItem.linkId,
          text: firstItem.text,
          answer: [{ valueString: "e2e test" }],
        },
      ]
    : [],
};

const { bundle: responseBundle, task: responseTask } = buildResponseBundle(
  answered,
  parsedRequest.task,
);

check(
  "filler/responseTaskCompleted",
  responseTask?.status === "completed",
  responseTask?.status,
);
check(
  "filler/responseTaskPointsAtResponse",
  responseTask?.output?.[0]?.valueReference?.reference?.startsWith(
    "urn:uuid:",
  ) === true,
);
check(
  "filler/noDanglingFocus",
  responseTask?.focus === undefined,
  "focus dropped with the Questionnaire",
);
check(
  "filler/canonicalPreservedInInput",
  responseTask?.input?.some((input) => input.valueCanonical) === true,
);
check(
  "filler/responseCarriesNoQuestionnaire",
  Buffer.byteLength(JSON.stringify(responseBundle)) < questionnaireBytes,
  `${Buffer.byteLength(JSON.stringify(responseBundle))} bytes`,
);

console.log("\n--- requester: review and accept ---");

const parsedResponse = parseResponseBundle(responseBundle);
check("review/notARequest", !isRequestBundle(responseBundle));
check(
  "review/correlationMatches",
  taskCorrelationId(parsedResponse.task) === taskCorrelationId(requestTask),
  taskCorrelationId(parsedResponse.task),
);

// The requester resolves the form from the canonical, exactly as the UI does.
const resolved = await fetchQuestionnaireByCanonical(
  FORMS_SERVER,
  questionnaireCanonical(parsedResponse.response),
);
check(
  "review/resolvesQuestionnaire",
  resolved.url === picked.url,
  resolved.url,
);

const destinations = resolveDestinations({
  questionnaire: resolved,
  responseServerUrl: WRITE_SERVER,
});
check("review/destination", destinations.length === 1, destinations.join(", "));

const results = await submitResponse({
  response: parsedResponse.response,
  task: parsedResponse.task,
  questionnaire: resolved,
  responseServerUrl: WRITE_SERVER,
});

for (const result of results) {
  check(
    "review/saved",
    !!result.responseId,
    result.error ??
      `QuestionnaireResponse/${result.responseId} · Task/${result.taskId}`,
  );

  if (result.responseId) {
    // Confirm it really landed, and that the Task points at the real id rather than a urn:uuid.
    const stored = (await (
      await fetch(
        `${WRITE_SERVER}/QuestionnaireResponse/${result.responseId}`,
        {
          headers: { Accept: "application/fhir+json" },
        },
      )
    ).json()) as QuestionnaireResponse;
    check(
      "review/storedRoundTrip",
      stored.item?.[0]?.answer?.[0]?.valueString === "e2e test",
    );

    if (result.taskId) {
      const storedTask = (await (
        await fetch(`${WRITE_SERVER}/Task/${result.taskId}`, {
          headers: { Accept: "application/fhir+json" },
        })
      ).json()) as { output?: { valueReference?: { reference?: string } }[] };
      check(
        "review/taskLinksRealResponseId",
        storedTask.output?.[0]?.valueReference?.reference ===
          `QuestionnaireResponse/${result.responseId}`,
        storedTask.output?.[0]?.valueReference?.reference,
      );
    }
  }
}

console.log("\n--- channel C: the encrypted reply ---");

/*
 * The same form answered again, but returned the way a phone app has to: encrypted to the requester's
 * public key and left in the slot. Nothing is pushed to the requester, and the slot host never sees
 * plaintext.
 *
 * A distinct answer, not a reuse of `answered`. Partly so the assertions below prove they read the
 * *reply* rather than the response already written by the link path, and partly because a byte-identical
 * second create is refused outright by servers that deduplicate:
 *
 *   HAPI-2840: Can not create resource duplicating existing resource: QuestionnaireResponse/…
 */
const replyAnswer = `e2e reply ${runId.slice(0, 8)}`;
const answeredForReply: QuestionnaireResponse = {
  ...answered,
  authored: new Date().toISOString(),
  item: firstItem
    ? [
        {
          linkId: firstItem.linkId,
          text: firstItem.text,
          answer: [{ valueString: replyAnswer }],
        },
      ]
    : [],
};

const { bundle: replyBundle } = buildReplyBundle(answeredForReply, {
  requestTask: parsedRequest.task,
});
const replyJwe = await encryptReplyJwe(
  encodeUtf8(JSON.stringify(replyBundle)),
  openedDescriptor!.publicJwk,
);

check(
  "reply/descriptorNotEchoedBack",
  !JSON.stringify(replyBundle).includes(replySlotUrl),
  "a reply must not carry the capability to write another reply",
);

await putReply(openedDescriptor!.replyUrl, replyJwe);

const storedSlot = await pollReply(replySlotUrl);
check("reply/slotNowReady", storedSlot.status === "ready", storedSlot.status);

const rawSlotBody = await (await fetch(replySlotUrl)).text();
check(
  "reply/slotIsJwe",
  rawSlotBody.split(".").length === 5,
  `${rawSlotBody.length} bytes`,
);
check(
  "reply/slotLeaksNoAnswers",
  !rawSlotBody.includes("QuestionnaireResponse") &&
    !rawSlotBody.includes(replyAnswer) &&
    !rawSlotBody.includes("PATAST"),
  "the host holds ciphertext only",
);

// A reply must be readable only by the holder of the private key — not by anyone with the invitation.
let strangerKeyRejected = false;
try {
  await decryptReplyJwe(rawSlotBody, (await generateReplyKeyPair()).privateJwk);
} catch {
  strangerKeyRejected = true;
}
check(
  "reply/strangerKeyRejected",
  strangerKeyRejected,
  "a leaked link must not decrypt the answers",
);

const collected = parseResponseBundle(
  JSON.parse(
    decodeUtf8(await decryptReplyJwe(rawSlotBody, replyKeys.privateJwk)),
  ),
);

check(
  "reply/decryptsToResponse",
  collected.response.resourceType === "QuestionnaireResponse",
);
check(
  "reply/answersSurvive",
  collected.response.item?.[0]?.answer?.[0]?.valueString === replyAnswer,
  "the answer read back must be the reply, not the earlier link-path response",
);
check(
  "reply/patientAsserted",
  (collected.response.meta?.security ?? []).some(
    (coding) => coding.code === "PATAST",
  ),
);
check("reply/hasProvenance", collected.provenance !== undefined);
check(
  "reply/correlationMatches",
  taskCorrelationId(collected.task) === taskCorrelationId(requestTask),
  taskCorrelationId(collected.task),
);

// And it writes, with its attribution intact.
const replyResults = await submitResponse({
  response: collected.response,
  task: collected.task,
  provenance: collected.provenance,
  questionnaire: resolved,
  responseServerUrl: WRITE_SERVER,
});

check(
  "reply/saved",
  !!replyResults[0]?.responseId,
  replyResults[0]?.error ??
    `QuestionnaireResponse/${replyResults[0]?.responseId} · Task/${replyResults[0]?.taskId} · Provenance/${replyResults[0]?.provenanceId}`,
);
check("reply/provenanceSaved", !!replyResults[0]?.provenanceId);

if (replyResults[0]?.responseId) {
  const storedReply = (await (
    await fetch(
      `${WRITE_SERVER}/QuestionnaireResponse/${replyResults[0].responseId}`,
      {
        headers: { Accept: "application/fhir+json" },
      },
    )
  ).json()) as QuestionnaireResponse;

  check(
    "reply/storedKeepsPatientAssertedLabel",
    (storedReply.meta?.security ?? []).some(
      (coding) => coding.code === "PATAST",
    ),
    "the label has to survive the write, not just the transport",
  );
}

if (replyResults[0]?.provenanceId) {
  const storedProvenance = (await (
    await fetch(`${WRITE_SERVER}/Provenance/${replyResults[0].provenanceId}`, {
      headers: { Accept: "application/fhir+json" },
    })
  ).json()) as { target?: { reference?: string }[] };

  check(
    "reply/storedProvenanceTargetsRealId",
    storedProvenance.target?.[0]?.reference ===
      `QuestionnaireResponse/${replyResults[0].responseId}`,
    storedProvenance.target?.[0]?.reference,
  );
}

console.log("\n--- request tracking: publish the Task, then list it back ---");

/*
 * The path that channel B and `/requests` both depend on, and the one that a unit check cannot prove: a
 * Task has to be *accepted by a real FHIR server*. It is asserted live because the constraint that broke
 * it is server-side — a canonical in `Task.focus` is rejected with HAPI-0506, so the published copy drops
 * `focus` and keeps the canonical in `input`.
 */
const publishedTaskUrl = await publishRequestTask(WRITE_SERVER, picked, {
  subjectReference,
  subjectDisplay: "SHL E2E Test",
  requestId: taskCorrelationId(requestTask)?.replace(/^urn:uuid:/, ""),
});
created.push(publishedTaskUrl);

check(
  "tracking/taskAccepted",
  publishedTaskUrl.startsWith(`${WRITE_SERVER}/Task/`),
  publishedTaskUrl,
);

const storedRequestTask = (await (
  await fetch(publishedTaskUrl, {
    headers: { Accept: "application/fhir+json" },
  })
).json()) as Task;

check(
  "tracking/focusDropped",
  storedRequestTask.focus === undefined,
  "a canonical focus would have been rejected",
);
check(
  "tracking/canonicalSurvivesInInput",
  storedRequestTask.input?.[0]?.valueCanonical ===
    questionnaireCanonicalOf(picked),
  storedRequestTask.input?.[0]?.valueCanonical,
);
check(
  "tracking/noReplyDescriptorOnServer",
  storedRequestTask.extension === undefined &&
    !JSON.stringify(storedRequestTask).includes(replySlotUrl) &&
    !JSON.stringify(storedRequestTask).includes(replyKeys.publicJwk.x),
  "the reply slot and key must not reach a readable server",
);
check(
  "tracking/addresseeStored",
  storedRequestTask.for?.display === "SHL E2E Test",
);

const listed = await searchPublishedRequests(WRITE_SERVER, 50);
const listedIds = listed.resources.map((task) => task.id);
check(
  "tracking/foundByTagSearch",
  listedIds.includes(publishedTaskUrl.split("/").pop()!),
  `${listed.resources.length} tagged Task(s) on the server`,
);

// The join that makes `/requests` work: a listed Task pairs with the local record by identifier alone.
const mergedLive = mergeSentRequests(
  [
    {
      id: taskCorrelationId(requestTask)!,
      label: picked.title ?? "Questionnaire",
      createdAt: new Date().toISOString(),
      link: requestLink,
      reply: { url: replySlotUrl, privateJwk: replyKeys.privateJwk },
    },
  ],
  listed.resources,
);
const liveRow = mergedLive.find(
  (row) => row.id === taskCorrelationId(requestTask),
);
check(
  "tracking/joinsToLocalRecord",
  liveRow?.origin === "tracked",
  liveRow?.origin,
);
check("tracking/joinedRowIsCollectable", liveRow?.collectable === true);

console.log("\n--- foreign: a response link this app did not mint ---");

/*
 * The primary return path is a filler minting its own link, so the shape that actually has to work
 * is one this app would never produce: a bare `QuestionnaireResponse` rather than a Bundle, hosted
 * by somebody else. Manifest mode and the passcode path cannot be covered here — a FHIR `Binary`
 * cannot answer a manifest `POST`, and there is no manifest server to point at — so those are
 * asserted offline in `check:roundtrip` instead.
 */
const foreignResponse: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: questionnaireCanonicalOf(picked),
  subject: { reference: subjectReference },
  authored: new Date().toISOString(),
  meta: { security: [{ ...PATIENT_ASSERTED_SECURITY }] },
  item: parsedResponse.response.item,
};

const foreignKey = generateKey();
const foreignBinaryUrl = await blobStore.put(
  encodeUtf8(
    await encryptJwe(encodeUtf8(JSON.stringify(foreignResponse)), foreignKey),
  ),
  JOSE_CONTENT_TYPE,
);
created.push(foreignBinaryUrl);

const foreignLink = `https://links.example.org/view#shlink:/${Buffer.from(
  JSON.stringify({
    url: foreignBinaryUrl,
    key: keyToBase64Url(foreignKey),
    flag: "U",
    v: 1,
    label: "Answers from another app",
  }),
).toString("base64url")}`;

const foreignDecoded = await shlCodec.decode(foreignLink);
check(
  "foreign/bareResourceOpens",
  parseResponseBundle(foreignDecoded.bundle).response.resourceType ===
    "QuestionnaireResponse",
  "a filler that hosts a bare resource rather than a Bundle has done nothing wrong",
);
check(
  "foreign/notMistakenForARequest",
  !isRequestBundle(foreignDecoded.bundle),
);

const foreignResults = await submitResponse({
  response: parseResponseBundle(foreignDecoded.bundle).response,
  questionnaire: resolved,
  responseServerUrl: WRITE_SERVER,
});
check(
  "foreign/storesAfterReview",
  foreignResults[0]?.responseId !== undefined,
  foreignResults[0]?.error ?? foreignResults[0]?.responseId,
);

console.log("\n--- deferred: a request minted with no reply channel ---");

/*
 * With `enableEncryptedReply` off — the default — the invitation is just the form. Asserted against
 * the wire rather than the config, because what matters is that nothing about a reply slot reaches
 * the payload, not that a boolean says it should not.
 */
const plainRequest = buildRequestBundle(picked, {
  requestId: crypto.randomUUID(),
  subjectReference,
  subjectDisplay: "E2E Test",
});

const plainBinaryUrl = await blobStore.put(
  encodeUtf8(
    await encryptJwe(
      encodeUtf8(JSON.stringify(plainRequest.bundle)),
      generateKey(),
    ),
  ),
  JOSE_CONTENT_TYPE,
);
created.push(plainBinaryUrl);

const plainBlob = await (await fetch(plainBinaryUrl)).text();
check(
  "deferred/noDescriptorOnTask",
  parseReplyDescriptor(plainRequest.task) === undefined,
);
check(
  "deferred/blobLeaksNoReplyUrl",
  !JSON.stringify(plainRequest.bundle).includes("replyUrl") &&
    !JSON.stringify(plainRequest.bundle).includes("publicJwk"),
  "with the channel off there is no slot and no key to leak",
);
check(
  "deferred/hostedBlobStillOpaque",
  plainBlob.split(".").length === 5 && !plainBlob.includes("Questionnaire"),
  `${plainBlob.length} bytes of JWE`,
);

console.log("\n--- correlation: matching returned answers to the request ---");

check(
  "correlate/identifierSurvivesRoundTrip",
  taskCorrelationId(parsedResponse.task) === taskCorrelationId(requestTask),
  `${taskCorrelationId(parsedResponse.task)} vs ${taskCorrelationId(requestTask)}`,
);
check(
  "correlate/findsTheLocalRecord",
  findRequestForTask(
    [
      {
        id: taskCorrelationId(requestTask)!,
        label: picked.title ?? "Questionnaire",
        createdAt: new Date().toISOString(),
        link: requestLink,
      },
    ],
    parsedResponse.task,
  )?.id === taskCorrelationId(requestTask),
  "this is what stamps a scanned response back onto its row in /requests",
);

console.log("\n--- failure mode: a subject the requester does not know ---");

/*
 * A response from a third-party app will often name a patient that does not exist on the requester's
 * server. The write must fail with a message the reviewer can act on, not a bare 400 — and it must
 * NOT be papered over by silently dropping the subject, which would lose who the answers are about.
 */
const strangerResults = await submitResponse({
  response: {
    ...parsedResponse.response,
    subject: { reference: "Patient/does-not-exist" },
  },
  questionnaire: resolved,
  responseServerUrl: WRITE_SERVER,
});

const strangerError = strangerResults[0]?.error ?? "";
check("stranger/rejected", !strangerResults[0]?.responseId);
check(
  "stranger/errorIsActionable",
  strangerError.includes("does-not-exist") && strangerError.includes("subject"),
  strangerError,
);

console.log("\n--- cleanup ---");

/*
 * Delete in reverse dependency order. The server enforces referential integrity on delete too:
 *
 *   409: Unable to delete Patient/x because at least one resource has a reference to this resource.
 *        First reference found was resource QuestionnaireResponse/y in path QuestionnaireResponse.subject
 *
 * An earlier version swallowed that with `.catch(() => undefined)` and silently left test Patients
 * behind, so failures are reported here rather than ignored.
 */
// Every write, including the foreign-link one — anything referencing the test Patient has to go
// before it, or the Patient delete fails with a 409 and the run leaves data behind.
const written = [...results, ...replyResults, ...foreignResults];
const toDelete = [
  // Provenance references the response, so it goes before it.
  ...written
    .filter((r) => r.provenanceId)
    .map((r) => `${WRITE_SERVER}/Provenance/${r.provenanceId}`),
  ...written
    .filter((r) => r.taskId)
    .map((r) => `${WRITE_SERVER}/Task/${r.taskId}`),
  ...written
    .filter((r) => r.responseId)
    .map((r) => `${WRITE_SERVER}/QuestionnaireResponse/${r.responseId}`),
  ...created,
  `${WRITE_SERVER}/${subjectReference}`,
];

let deleted = 0;
for (const url of toDelete) {
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
  deleted === toDelete.length,
  `${deleted}/${toDelete.length} deleted`,
);

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
