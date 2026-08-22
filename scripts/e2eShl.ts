/**
 * Live end-to-end check of the SMART Health Link wire contract, minus the UI.
 *
 *   requester: pick a form (live catalogue) -> invitation Bundle -> seal it -> host a manifest
 *   filler:    POST the manifest -> decrypt -> read the form, the Task and the grant -> answer
 *
 *   npm run check:e2e-shl
 *
 * The questionnaire is fetched from the live forms server and the manifest is served over real
 * HTTP from a throwaway server on localhost, so every hop the filler makes is a real one: a
 * manifest `POST`, a JWE the reader has to dispatch on `cty`, and a Bundle it has to take apart.
 *
 * ## What this no longer covers, and where it went
 *
 * It used to write to a FHIR server named by `SHL_WRITE_SERVER`: a Binary to host the payload, a
 * reply slot, a Patient, a QuestionnaireResponse, a Task. None of those writes exist any more.
 * The payload is hosted by this app's own BFF (FR-013), the reply slot is gone (FR-029), and
 * every requester write now goes through the session proxy - which this script cannot obtain,
 * because it is a command-line process with no SMART launch. Those paths are covered by
 * `tests/server/**` offline and by the Playwright suite (`npm run test:e2e`) against Aidbox.
 *
 * What is left here is the part that has to hold for a link minted by this app to open in
 * somebody else's reader, which is exactly the part a unit test cannot prove: real HTTP, real
 * compression, real AES-GCM, real JSON.
 * @author John Grimes
 */
import { createServer } from "node:http";

import {
  fetchQuestionnaireByCanonical,
  searchQuestionnaires,
} from "../src/fhir/formsServer";
import { buildGrant, GRANT_CONTENT_TYPE } from "../src/link/apiAccess";
import { decodeUtf8, encodeUtf8 } from "../src/link/binary";
import { questionnaireCanonical } from "../src/link/codec";
import {
  buildResponseBundle,
  isRequestBundle,
  parseRequestBundle,
  parseResponseBundle,
  questionnaireCanonicalOf,
  taskCorrelationId,
} from "../src/link/exchange";
import { buildInvitationBundle } from "../src/link/invitationBundle";
import {
  decryptJwe,
  encryptJwe,
  generateKey,
  keyToBase64Url,
} from "../src/link/jwe";
import { chooseErrorCorrectionLevel } from "../src/link/qrCapacity";
import { parseServerTaskUrl } from "../src/link/replyDescriptor";
import { shlCodec } from "../src/link/shlCodec";

import type { QuestionnaireResponse } from "fhir/r4";
import type { AddressInfo } from "node:net";

/** Read-only catalogue the form comes from. Never written to. */
const FORMS_SERVER = "https://smartforms.csiro.au/api/fhir";

/** Origin the minted link points at. */
const BASE_URL = "https://links.example.org";

/** The launched server an invitation minted by this app would name. */
const ISSUER = "https://ehr.example.org/fhir";

/** Content type of the invitation file. */
const INVITATION_CONTENT_TYPE = "application/fhir+json";

/** The patient this request is addressed to. */
const SUBJECT_REFERENCE = "Patient/e2e-subject";

let failures = 0;
let total = 0;

/**
 * Record one assertion.
 * @param name what is being asserted
 * @param condition whether it held
 * @param detail extra context to print
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

console.log(`forms server (read only): ${FORMS_SERVER}\n`);
console.log("--- requester: build the invitation ---");

const questionnaires = await searchQuestionnaires(FORMS_SERVER, "", 100);
const picked = questionnaires.find(
  (candidate) =>
    candidate.url && candidate.id && (candidate.item?.length ?? 0) > 0,
);
if (!picked) {
  console.error("No suitable questionnaire found.");
  process.exit(1);
}
console.log(`  form: ${picked.title ?? picked.id}`);
console.log(
  `        ${picked.url}${picked.version ? `|${picked.version}` : ""}`,
);

const questionnaireBytes = Buffer.byteLength(JSON.stringify(picked));
const requestId = crypto.randomUUID();
const publishedTaskUrl = `${ISSUER}/Task/${requestId.slice(0, 8)}`;

/*
 * Two builds of the same request, exactly as `POST /api/invitations` does it: one to publish to
 * the launched server, one to seal into the invitation naming where that copy landed.
 */
const toPublish = buildInvitationBundle(picked, {
  requestId,
  requesterDisplay: "E2E Practice",
  subjectReference: SUBJECT_REFERENCE,
  subjectDisplay: "SHL E2E Test",
});
const invitation = buildInvitationBundle(picked, {
  requestId,
  requesterDisplay: "E2E Practice",
  subjectReference: SUBJECT_REFERENCE,
  subjectDisplay: "SHL E2E Test",
  publishedTaskUrl,
});

check("request/isRequestBundle", isRequestBundle(invitation.bundle));
check(
  "request/hasCorrelationId",
  taskCorrelationId(invitation.task) === invitation.requestIdentifier,
  invitation.requestIdentifier,
);
check(
  "request/focusIsCanonical",
  invitation.task.focus?.reference === questionnaireCanonicalOf(picked) &&
    invitation.task.focus?.type === "Questionnaire",
  invitation.task.focus?.reference,
);
check(
  "request/canonicalAlsoInInput",
  invitation.task.input?.[0]?.valueCanonical ===
    questionnaireCanonicalOf(picked),
);
check(
  "request/addresseeIsReadable",
  invitation.task.for?.display === "SHL E2E Test",
);
check(
  "request/senderIsReadable",
  invitation.task.requester?.display === "E2E Practice",
);
check(
  "request/namesThePublishedTask",
  parseServerTaskUrl(invitation.task) === publishedTaskUrl,
  publishedTaskUrl,
);
check(
  "request/publishedCopyClaimsNoUrl",
  parseServerTaskUrl(toPublish.task) === undefined,
  "the copy written to the server cannot point at itself",
);

console.log("\n--- requester: seal it and host a manifest ---");

const linkKey = generateKey();
const invitationFile = await encryptJwe(
  encodeUtf8(JSON.stringify(invitation.bundle)),
  linkKey,
  { contentType: INVITATION_CONTENT_TYPE },
);

/*
 * The grant a manifest fetch mints. The token is a placeholder - minting needs an authorisation
 * server - but everything around it is the real producer, including its refusal to state a grant
 * it could not honour.
 */
const grant = buildGrant({
  accessToken: "e2e-placeholder-token",
  tokenType: "Bearer",
  expiresIn: 3600,
  aud: ISSUER,
  patientId: SUBJECT_REFERENCE.split("/", 2)[1],
  grantTtlSeconds: 3600,
});
if (!grant) {
  console.error("The grant producer declined a well-formed token response.");
  process.exit(1);
}
const grantFile = await encryptJwe(encodeUtf8(JSON.stringify(grant)), linkKey, {
  contentType: GRANT_CONTENT_TYPE,
});

/** A foreign `U`-flag payload: a bare resource, hosted by somebody else's app. */
const foreignKey = generateKey();
const foreignResponse: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: questionnaireCanonicalOf(picked),
  authored: new Date().toISOString(),
  item: [{ linkId: picked.item?.[0]?.linkId ?? "1" }],
};
const foreignFile = await encryptJwe(
  encodeUtf8(JSON.stringify(foreignResponse)),
  foreignKey,
);

let manifestFetches = 0;

const host = createServer((request, response) => {
  if (request.url === "/foreign" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/jose" });
    response.end(foreignFile);
    return;
  }
  if (request.url === "/shl/e2e" && request.method === "POST") {
    // The body is read and discarded, as the real route does: `recipient` is never logged.
    request.resume();
    request.on("end", () => {
      manifestFetches += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          files: [
            { contentType: INVITATION_CONTENT_TYPE, embedded: invitationFile },
            { contentType: GRANT_CONTENT_TYPE, embedded: grantFile },
          ],
        }),
      );
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const port = (host.address() as AddressInfo).port;
const manifestUrl = `http://127.0.0.1:${port}/shl/e2e`;

const shlPayload = {
  url: manifestUrl,
  key: keyToBase64Url(linkKey),
  exp: Math.floor(Date.now() / 1000) + 30 * 86_400,
  label: picked.title ?? "Questionnaire",
};
const link = `${BASE_URL}/view#shlink:/${Buffer.from(
  JSON.stringify(shlPayload),
).toString("base64url")}`;

console.log(
  `  questionnaire: ${questionnaireBytes} bytes  ->  link: ${Buffer.byteLength(link)} bytes`,
);
check(
  "link/carriesNoFlag",
  !("flag" in shlPayload),
  "no U (this URL is a manifest) and no P",
);
check(
  "link/fitsQr",
  chooseErrorCorrectionLevel(link) !== null,
  `level ${chooseErrorCorrectionLevel(link)}`,
);
check(
  "link/isTinyDespiteBigForm",
  Buffer.byteLength(link) < 500 && questionnaireBytes > 2000,
  `${questionnaireBytes} -> ${Buffer.byteLength(link)}`,
);
check(
  "link/leaksNothing",
  !link.includes("e2e-placeholder-token") &&
    !link.includes("linkId") &&
    !link.includes(SUBJECT_REFERENCE),
  "the link carries a pointer and a key, nothing else",
);

console.log("\n--- filler: fetch the manifest and open the invitation ---");

const opened = await shlCodec.decode(link);
check("filler/decodesRequest", isRequestBundle(opened.bundle));
check(
  "filler/manifestWasFetchedOverHttp",
  manifestFetches === 1,
  `${manifestFetches} fetch(es)`,
);

const parsedRequest = parseRequestBundle(opened.bundle);
check(
  "filler/questionnaireArrivedWhole",
  JSON.stringify(parsedRequest.questionnaire) === JSON.stringify(picked),
  "no forms-server access was needed",
);
check(
  "filler/taskCorrelationSurvives",
  taskCorrelationId(parsedRequest.task) === invitation.requestIdentifier,
);
check(
  "filler/subjectSurvives",
  parsedRequest.task.for?.reference === SUBJECT_REFERENCE,
);
check(
  "filler/seesSender",
  parsedRequest.task.requester?.display === "E2E Practice",
);
check(
  "filler/readsPublishedTaskUrl",
  parseServerTaskUrl(parsedRequest.task) === publishedTaskUrl,
  "this is what entitles a filler to complete the Task on the destination",
);

/*
 * The reader dispatches the grant out of the manifest and hands it back beside the payload rather
 * than reporting it as a file it skipped (T037). Beside, never inside: a bearer token must not end
 * up in the Bundle the form is built from.
 */
check(
  "filler/surfacesTheGrantBesideThePayload",
  opened.apiAccess?.grant.aud === ISSUER &&
    opened.apiAccess.grant.patient === "e2e-subject" &&
    opened.apiAccess.grant.token_type === "Bearer" &&
    opened.apiAccess.grant.expires_in === 3600 &&
    typeof opened.apiAccess.receivedAt === "number",
  JSON.stringify({
    grant: { ...opened.apiAccess?.grant, access_token: "<redacted>" },
    receivedAt: opened.apiAccess?.receivedAt,
  }),
);
check(
  "filler/doesNotReportTheGrantAsSkipped",
  !(opened.warnings ?? []).some((warning) =>
    warning.includes(GRANT_CONTENT_TYPE),
  ),
  (opened.warnings ?? []).join(" | "),
);
check(
  "filler/keepsTheTokenOutOfThePayload",
  !JSON.stringify(opened.bundle).includes(
    opened.apiAccess?.grant.access_token ?? "\u0000",
  ),
  "a bearer token in the Bundle would travel wherever the answers travel",
);

console.log("\n--- filler: the grant ---");

const manifestResponse = await fetch(manifestUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ recipient: "Smart Forms Health Links" }),
});
const manifest = (await manifestResponse.json()) as {
  files: { contentType: string; embedded: string }[];
};

check(
  "grant/manifestHasTwoFiles",
  manifest.files.length === 2,
  manifest.files.map((file) => file.contentType).join(", "),
);

const grantJwe = manifest.files[1].embedded;
const grantHeader = JSON.parse(
  Buffer.from(grantJwe.split(".", 1)[0], "base64url").toString(),
) as Record<string, string>;
check(
  "grant/headerDeclaresItsType",
  grantHeader.cty === GRANT_CONTENT_TYPE &&
    grantHeader.alg === "dir" &&
    grantHeader.enc === "A256GCM",
  JSON.stringify(grantHeader),
);

const openedGrant = JSON.parse(
  decodeUtf8(await decryptJwe(grantJwe, linkKey)),
) as Record<string, unknown>;
check(
  "grant/fieldsMatchTheContract",
  openedGrant.token_type === "Bearer" &&
    openedGrant.aud === ISSUER &&
    openedGrant.expires_in === 3600 &&
    openedGrant.patient === "e2e-subject",
  JSON.stringify({ ...openedGrant, access_token: "<redacted>" }),
);
check(
  "grant/tokenTravelsOnlyEncrypted",
  !JSON.stringify(manifest.files.map((file) => file.contentType)).includes(
    "e2e-placeholder-token",
  ) && !manifest.files[0].embedded.includes("e2e-placeholder-token"),
  "the token exists nowhere in the manifest but inside its own sealed file",
);

let strangerRejected = false;
try {
  await decryptJwe(grantJwe, generateKey());
} catch {
  strangerRejected = true;
}
check(
  "grant/strangerKeyRejected",
  strangerRejected,
  "the grant is readable only by the holder of the link",
);

console.log("\n--- filler: answer it ---");

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
  "answer/responseTaskCompleted",
  responseTask?.status === "completed",
  responseTask?.status,
);
check(
  "answer/noDanglingFocus",
  responseTask?.focus === undefined,
  "focus dropped with the Questionnaire",
);
check(
  "answer/canonicalPreservedInInput",
  responseTask?.input?.some((input) => input.valueCanonical) === true,
);
check(
  "answer/carriesNoQuestionnaire",
  Buffer.byteLength(JSON.stringify(responseBundle)) < questionnaireBytes,
  `${Buffer.byteLength(JSON.stringify(responseBundle))} bytes`,
);

const parsedResponse = parseResponseBundle(responseBundle);
check("answer/notMistakenForARequest", !isRequestBundle(responseBundle));
check(
  "answer/correlationMatches",
  taskCorrelationId(parsedResponse.task) === invitation.requestIdentifier,
  taskCorrelationId(parsedResponse.task),
);

// The requester resolves the form from the canonical, exactly as the review screen does.
const resolved = await fetchQuestionnaireByCanonical(
  FORMS_SERVER,
  questionnaireCanonical(parsedResponse.response),
);
check(
  "answer/resolvesQuestionnaire",
  resolved.url === picked.url,
  resolved.url,
);

console.log("\n--- foreign: a link this app did not mint ---");

/*
 * A filler minting its own return link is the fallback channel, and the shape it produces is one
 * this app never would: a bare `QuestionnaireResponse` behind a `U`-flag URL fetched with a plain
 * `GET`. Reading it has to keep working (FR-028).
 */
const foreignLink = `${BASE_URL}/view#shlink:/${Buffer.from(
  JSON.stringify({
    url: `http://127.0.0.1:${port}/foreign`,
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

await new Promise<void>((resolve, reject) => {
  host.close((error) => (error ? reject(error) : resolve()));
});

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
