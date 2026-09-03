/**
 * Live check of the amendment path: what happens when a reviewer needs to change answers somebody
 * else gave.
 *
 *   store the response exactly as it arrived
 *     -> POST a SECOND QuestionnaireResponse carrying the edits, authored by the reviewer
 *     -> POST a Provenance with entity.role = revision pointing back at the first
 *
 * The point of the check is the things that must *not* happen: the original is never updated, its
 * `PATAST` label is never carried onto content the reviewer wrote, and the patient never ends up
 * named as the author of words they did not say. Those are one-line mistakes to make and invisible
 * afterwards, which is why they are asserted against a real server rather than reasoned about.
 *
 * Everything written — two QuestionnaireResponses and a Provenance — goes to `SHL_WRITE_SERVER` and is
 * deleted again in reverse dependency order.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:amend
 */
import {
  AMENDMENT_TARGET_PLACEHOLDER,
  buildAmendment,
} from "../src/fhir/amend";
import { submitAmendment, submitResponse } from "../src/fhir/submit";
import { PATIENT_ASSERTED_SECURITY } from "../src/link/exchange";

import type { Provenance, QuestionnaireResponse } from "fhir/r4";

const FORMS_SERVER = "https://smartforms.csiro.au/api/fhir";
const WRITE_SERVER = process.env.SHL_WRITE_SERVER;

if (!WRITE_SERVER) {
  console.log(
    "Skipped: set SHL_WRITE_SERVER to a FHIR server this test may write to.\n" +
      "  It creates two QuestionnaireResponses and a Provenance, and cleans up after itself.\n" +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      "  SHL_WRITE_SERVER=https://your-server/fhir npm run check:amend",
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

const created: { type: string; id: string }[] = [];

async function read<T>(type: string, id: string): Promise<T> {
  const response = await fetch(`${WRITE_SERVER}/${type}/${id}`, {
    headers: { Accept: "application/fhir+json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${type}/${id} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

const CANONICAL = "http://example.org/Questionnaire/amend-probe";
const AMENDER = "Dr Jane Roe";

/*
 * Shaped like a reply from a third-party filler, because that is the case amendment exists for: the
 * answers are patient-asserted, the patient is the `source`, and the resource carries an id from a
 * server that is not this one.
 */
const incoming: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  id: "foreign-id-that-must-not-survive",
  meta: {
    versionId: "9",
    security: [{ ...PATIENT_ASSERTED_SECURITY }],
    tag: [{ system: "http://example.org/tags", code: "keep-me" }],
  },
  status: "completed",
  questionnaire: CANONICAL,
  source: { display: "Jane Citizen" },
  item: [
    {
      linkId: "q1",
      text: "Smoking status",
      answer: [{ valueString: "never" }],
    },
  ],
};

console.log(`write server: ${WRITE_SERVER}\n`);

try {
  console.log("--- accept the answers as they arrived ---");
  const [saved] = await submitResponse({
    response: incoming,
    responseServerUrl: WRITE_SERVER,
  });
  if (!saved.responseId) {
    throw new Error(`the original was not stored: ${saved.error}`);
  }
  created.push({ type: "QuestionnaireResponse", id: saved.responseId });
  console.log(`  QuestionnaireResponse/${saved.responseId}`);

  const original = await read<QuestionnaireResponse>(
    "QuestionnaireResponse",
    saved.responseId,
  );
  check(
    "the stored original keeps PATAST",
    (original.meta?.security ?? []).some((c) => c.code === "PATAST"),
  );
  check(
    "the foreign id did not survive",
    original.id !== incoming.id,
    original.id,
  );
  check(
    "the answer is as given",
    original.item?.[0]?.answer?.[0]?.valueString === "never",
  );

  console.log("\n--- amend them ---");
  const edited: QuestionnaireResponse = {
    ...incoming,
    item: [
      {
        linkId: "q1",
        text: "Smoking status",
        answer: [{ valueString: "former" }],
      },
    ],
  };

  const [amended] = await submitAmendment({
    saved: [{ serverUrl: WRITE_SERVER, responseId: saved.responseId }],
    amend: (originalResponseId) =>
      buildAmendment({
        original,
        originalResponseId,
        edited,
        amender: AMENDER,
      }),
  });
  if (!amended.responseId) {
    throw new Error(`the amendment was not stored: ${amended.error}`);
  }
  created.push({ type: "QuestionnaireResponse", id: amended.responseId });
  if (amended.provenanceId) {
    created.push({ type: "Provenance", id: amended.provenanceId });
  }
  check(
    "the Provenance was written",
    !!amended.provenanceId,
    amended.provenanceError,
  );
  console.log(
    `  QuestionnaireResponse/${amended.responseId} · Provenance/${amended.provenanceId}`,
  );

  const amendment = await read<QuestionnaireResponse>(
    "QuestionnaireResponse",
    amended.responseId,
  );
  check(
    "the amendment is a separate resource",
    amendment.id !== saved.responseId,
  );
  check(
    "it carries the edit",
    amendment.item?.[0]?.answer?.[0]?.valueString === "former",
  );
  check("the reviewer is its author", amendment.author?.display === AMENDER);
  /*
   * `author` is who recorded the answers and `source` is who answered them. Overwriting `source` too
   * would erase the fact that a patient answered at all, which is the opposite of the point.
   */
  check(
    "the patient is still its source",
    amendment.source?.display === "Jane Citizen",
  );
  check(
    "PATAST does NOT ride along",
    !(amendment.meta?.security ?? []).some((c) => c.code === "PATAST"),
  );
  check(
    "other meta survives",
    (amendment.meta?.tag ?? []).some((t) => t.code === "keep-me"),
  );
  check(
    "it answers the same questionnaire",
    amendment.questionnaire === CANONICAL,
  );

  console.log("\n--- the Provenance joins the two ---");
  const provenance = await read<Provenance>(
    "Provenance",
    amended.provenanceId!,
  );
  check(
    "it targets the amendment",
    provenance.target?.[0]?.reference ===
      `QuestionnaireResponse/${amended.responseId}`,
  );
  check(
    "the placeholder target was rewritten",
    !JSON.stringify(provenance).includes(AMENDMENT_TARGET_PLACEHOLDER),
  );
  check("entity.role is revision", provenance.entity?.[0]?.role === "revision");
  check(
    "entity.what is the original",
    provenance.entity?.[0]?.what?.reference ===
      `QuestionnaireResponse/${saved.responseId}`,
  );
  check(
    "the agent is the reviewer",
    provenance.agent?.[0]?.who?.display === AMENDER,
  );
  check(
    "the activity is UPDATE",
    provenance.activity?.coding?.[0]?.code === "UPDATE",
  );

  /*
   * The one that matters most. Everything above could pass while the original was quietly updated in
   * place, which would defeat the whole design — so it is re-read and compared, version included.
   */
  console.log("\n--- and the original is untouched ---");
  const reread = await read<QuestionnaireResponse>(
    "QuestionnaireResponse",
    saved.responseId,
  );
  check(
    "its answer is unchanged",
    reread.item?.[0]?.answer?.[0]?.valueString === "never",
  );
  check(
    "it is still patient-asserted",
    (reread.meta?.security ?? []).some((c) => c.code === "PATAST"),
  );
  check("no author was grafted onto it", reread.author === undefined);
  check(
    "the server never versioned it",
    reread.meta?.versionId === original.meta?.versionId,
  );
} finally {
  console.log("\n--- cleanup ---");
  for (const { type, id } of created.toReversed()) {
    const response = await fetch(`${WRITE_SERVER}/${type}/${id}`, {
      method: "DELETE",
    });
    if (response.ok) {
      console.log(`  deleted ${type}/${id}`);
    } else {
      failures++;
      console.log(`  COULD NOT DELETE ${type}/${id} — ${response.status}`);
    }
  }
}

console.log(
  failures === 0
    ? `\n${total} checks passed`
    : `\n${failures} of ${total} checks FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
