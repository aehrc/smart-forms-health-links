/**
 * End-to-end check of the link flow against the live forms server, minus the UI:
 *
 *   search -> pick a form -> build a response -> encode a link -> decode it
 *          -> resolve the Questionnaire back from its canonical
 *
 * This is the path that actually has to hold for a scanned link to open, and every step of it
 * except the rendering is exercised here.
 *
 *   npm run check:e2e
 */
import {
  fetchQuestionnaireByCanonical,
  fetchQuestionnaireById,
  searchQuestionnaires,
  splitCanonical,
} from "../src/fhir/formsServer";
import { bespokeCodec } from "../src/link/bespokeCodec";
import {
  bundleResponse,
  defaultLabel,
  ensureQuestionnaireCanonical,
  questionnaireCanonical,
  responseFromBundle,
} from "../src/link/codec";
import { chooseErrorCorrectionLevel } from "../src/link/qrCapacity";

import type { QuestionnaireResponse } from "fhir/r4";

const FORMS_SERVER = "https://smartforms.csiro.au/api/fhir";
const BASE_URL = "https://links.example.org";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) {
    failures++;
  }
}

console.log(`forms server: ${FORMS_SERVER}\n`);

// 1. Search, as the form list does.
const questionnaires = await searchQuestionnaires(FORMS_SERVER, "", 100);
check(
  "search returns renderable questionnaires",
  questionnaires.length > 0,
  `${questionnaires.length} found`,
);
check(
  "every result has items",
  questionnaires.every((q) => (q.item?.length ?? 0) > 0),
);

// 2. Pick the first form that has a canonical url — that is what a link needs.
const picked = questionnaires.find((q) => !!q.url && !!q.id);
if (!picked) {
  console.error(
    "No questionnaire with both an id and a canonical url; cannot continue.",
  );
  process.exit(1);
}
console.log(`\npicked: ${picked.title ?? picked.id}\n        ${picked.url}\n`);

// 3. Fetch by id, as the fill route does.
const byId = await fetchQuestionnaireById(FORMS_SERVER, picked.id!);
check("fetch by id resolves the same form", byId.url === picked.url);

// 4. Build a response the way the renderer would, with one answer filled in.
const firstItem = byId.item?.[0];
const response: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "in-progress",
  item: firstItem
    ? [
        {
          linkId: firstItem.linkId,
          text: firstItem.text,
          answer: [{ valueString: "test answer" }],
        },
      ]
    : [],
};

const withCanonical = ensureQuestionnaireCanonical(response, byId);
check(
  "canonical is attached to the response",
  !!withCanonical.questionnaire,
  withCanonical.questionnaire,
);

// 5. Encode.
const link = await bespokeCodec.encode(
  { bundle: bundleResponse(withCanonical), label: defaultLabel(byId) },
  { baseUrl: BASE_URL },
);
const level = chooseErrorCorrectionLevel(link);
check(
  "link is QR-encodable",
  level !== null,
  `${Buffer.byteLength(link)} bytes, level ${level}`,
);

// 6. Decode, as the viewer does.
const decoded = await bespokeCodec.decode(link);
const decodedResponse = responseFromBundle(decoded.bundle);
check(
  "decoded response matches the original",
  JSON.stringify(decodedResponse) === JSON.stringify(withCanonical),
);
check("label survives the round trip", decoded.label === defaultLabel(byId));

// 7. Resolve the questionnaire back from the canonical — the step that makes a scanned link open.
const canonical = questionnaireCanonical(decodedResponse);
const resolved = await fetchQuestionnaireByCanonical(FORMS_SERVER, canonical);
check(
  "canonical resolves to the same questionnaire",
  resolved.url === byId.url,
  resolved.url,
);

const [, version] = splitCanonical(canonical);
if (version) {
  check(
    "version-pinned canonical resolves that version",
    resolved.version === version,
    resolved.version,
  );
}

check("resolved questionnaire is renderable", (resolved.item?.length ?? 0) > 0);

console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
