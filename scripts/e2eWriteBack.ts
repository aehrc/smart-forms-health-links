/**
 * Live end-to-end check of form data extraction and the write back into the record.
 *
 *   catalogue: search the real forms server -> confirm it still holds templated forms
 *   extract:   fixture answers -> retarget onto a patient this server actually holds
 *                              -> transaction Bundle
 *   write:     POST the Bundle to the server base -> every entry 2xx
 *   confirm:   read one created resource back and check whose record it landed in
 *
 * The last step is the one that cannot be checked offline and is the whole point. `check:roundtrip`
 * already proves the Bundle is well-formed and that `retargetSubject` rewrites what it should; what it
 * cannot prove is that a real FHIR server accepts a transaction full of resources a template wrote,
 * and files them against the right person. A Condition that lands against nobody is the failure this
 * feature exists to avoid, so it is asserted rather than assumed.
 *
 * The answers come from the sdc-template-extract fixtures in a sibling `../smart-forms` checkout,
 * because a template needs answers written against the exact form its templates were authored for, and
 * inventing them here would test the fixture rather than the feature.
 *
 * The forms server is read ONLY. Everything written goes to `SHL_WRITE_SERVER` and is deleted again
 * afterwards.
 *
 *   SHL_WRITE_SERVER=https://your-server/fhir npm run check:writeback
 */
import { QRSepsisRisk } from "../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRSepsisRisk";
import { QSepsisRisk } from "../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaires/QSepsisRisk";
import { searchQuestionnaires } from "../src/fhir/formsServer";
import { createPatient } from "../src/fhir/submit";
import {
  canTemplateExtract,
  retargetSubject,
  templateExtract,
} from "../src/fhir/templateExtract";
import {
  bundleWriteSucceeded,
  submitExtractedBundle,
} from "../src/fhir/writeBundle";
import { describeEntries, filterBundle } from "../src/lib/extractedEntries";

import type { Bundle, Questionnaire, QuestionnaireResponse } from "fhir/r4";

const FORMS_SERVER = "https://smartforms.csiro.au/api/fhir";
const WRITE_SERVER = process.env.SHL_WRITE_SERVER;

if (!WRITE_SERVER) {
  console.log(
    "Skipped: set SHL_WRITE_SERVER to a FHIR server this test may write to.\n" +
      "  It creates a Patient and whatever the Sepsis templates extract, and cleans up after itself.\n" +
      `  It must NOT be the forms server (${FORMS_SERVER}), which is a read-only catalogue.\n\n` +
      "  SHL_WRITE_SERVER=https://your-server/fhir npm run check:writeback",
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
  "--- catalogue: does the real forms server still hold templated forms? ---",
);

/*
 * Asserted against the live catalogue rather than the fixtures, because the feature is only worth
 * anything if forms people can actually pick declare extraction. If this ever drops to zero, the panel
 * silently stops appearing and nothing else in the suite would notice.
 */
const catalogue = await searchQuestionnaires(FORMS_SERVER, "", 200);
const templated = catalogue.filter((candidate) =>
  canTemplateExtract(candidate),
);

check(
  "catalogue/holdsTemplatedForms",
  templated.length > 0,
  `${templated.length} of ${catalogue.length} declare template-based extraction`,
);

// ---------------------------------------------------------------------------
console.log(
  "\n--- extract: fixture answers, retargeted onto a real patient ---",
);

const patient = await createPatient(WRITE_SERVER, {
  family: "Writeback",
  given: "Extraction Test",
  birthDate: "1970-01-01",
  gender: "unknown",
});
created.push(`${WRITE_SERVER}/${patient.reference}`);
console.log(`  patient: ${patient.reference}`);

const originalSubject = (QRSepsisRisk as QuestionnaireResponse).subject
  ?.reference;

/*
 * Exactly what `ReviewResponse` does before extracting: repoint the answers at the patient the
 * reviewer chose, then extract from *that*. Extracting first and repointing after would be the bug
 * this ordering exists to prevent.
 */
const reconciled: QuestionnaireResponse = {
  ...(QRSepsisRisk as QuestionnaireResponse),
  subject: {
    reference: patient.reference,
    display: "Extraction Test Writeback",
  },
};

const { bundle: rawBundle, issues } = await templateExtract(
  reconciled,
  QSepsisRisk as Questionnaire,
);
const bundle: Bundle = retargetSubject(rawBundle, reconciled, originalSubject);
const rows = describeEntries(bundle);

check(
  "extract/isATransaction",
  bundle.type === "transaction",
  bundle.type ?? "none",
);
check("extract/hasEntries", rows.length > 0, `${rows.length} entries`);
check(
  "extract/noneStillNameTheFillersPatient",
  originalSubject === undefined ||
    !JSON.stringify(bundle).includes(originalSubject),
  "a resource still pointing at the filler's own key would be rejected, or filed against a stranger",
);

if (issues) {
  console.log(
    `  note: engine reported issues — ${JSON.stringify(issues.issue?.[0] ?? {})}`,
  );
}

for (const row of rows) {
  console.log(
    `  ${row.method === "new" ? "+" : "~"} ${row.resourceType}: ${row.display}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n--- write: POST the transaction to the server base ---");

/*
 * Everything is selected, which is the panel's default. `filterBundle` is still exercised on the way
 * through, because a selection of "all" going down a different code path from a selection of "some"
 * is precisely the sort of difference that survives testing and breaks in front of a clinician.
 */
const selected = new Set(rows.map((row) => row.index));
const result = await submitExtractedBundle({
  serverUrl: WRITE_SERVER,
  bundle: filterBundle(bundle, selected),
});

check("write/succeeded", bundleWriteSucceeded(result), result.error ?? "");
check(
  "write/reportedEveryEntry",
  result.entries.length === rows.length,
  `${result.entries.length} responses for ${rows.length} entries`,
);

for (const entry of result.entries) {
  if (entry.location) {
    // `Condition/123/_history/1` → `Condition/123`, which is what DELETE wants.
    const [resourceType, id] = entry.location.split("/");
    if (resourceType && id) {
      created.push(`${WRITE_SERVER}/${resourceType}/${id}`);
    }
  }
  if (entry.error) {
    console.log(`  entry ${entry.index}: ${entry.error}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n--- confirm: whose record did it land in? ---");

const firstCreated = result.entries.find((entry) => entry.location);

if (firstCreated?.location) {
  const [resourceType, id] = firstCreated.location.split("/");
  const read = await fetch(`${WRITE_SERVER}/${resourceType}/${id}`, {
    headers: { Accept: "application/fhir+json" },
  });

  check(
    "confirm/readsBack",
    read.ok,
    `${read.status} for ${resourceType}/${id}`,
  );

  if (read.ok) {
    const stored = (await read.json()) as { subject?: { reference?: string } };
    check(
      "confirm/filedAgainstTheChosenPatient",
      stored.subject?.reference === patient.reference,
      `${stored.subject?.reference ?? "no subject"} vs ${patient.reference}`,
    );
  }
} else {
  check(
    "confirm/somethingWasCreated",
    false,
    "the server reported no location for any entry",
  );
}

// ---------------------------------------------------------------------------
console.log("\n--- cleanup ---");

let deleted = 0;
// Reversed so referencing resources go before the Patient they point at, which a server enforcing
// referential integrity will otherwise refuse to remove.
for (const url of [...created].toReversed()) {
  try {
    const response = await fetch(url, { method: "DELETE" });
    if (response.ok || response.status === 204 || response.status === 404) {
      deleted++;
    } else {
      console.log(`  could not delete ${url} — ${response.status}`);
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
