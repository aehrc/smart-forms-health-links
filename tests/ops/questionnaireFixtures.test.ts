/**
 * The Questionnaire fixtures this repo ships, loaded from disk and held to what the app assumes.
 *
 * Nothing in this suite had ever opened these files. `tests/ops/aidboxSetup.test.ts` builds its own
 * `QUESTIONNAIRES` array and feeds that to `planSetup`, which is the right way to test planning and
 * says nothing at all about the JSON on disk. So a fixture with a missing canonical URL, a duplicate
 * linkId or a missing pre-population extension was discoverable only by running
 * `npm run setup:aidbox` against a live Aidbox and then noticing the form misbehaving in a browser.
 *
 * That is the same shape of gap that let issue #18 ship: every check stopped short of the place the
 * value is actually used. These assertions are the properties the running app depends on, checked
 * against the bytes that will be uploaded.
 *
 * ## Two classes of assertion, deliberately separated
 *
 * **Universal** ones hold for every fixture and are the ones a new form is most likely to get wrong:
 * a canonical URL, because `buildInvitationBundle` refuses to mint an invitation without one; a
 * version, because walk-in review resolves the form back by `url` and `version`; at least one item,
 * because `isRenderableQuestionnaire` filters out anything else; unique linkIds, because an answer
 * is matched to its question by linkId and a duplicate silently merges two questions' answers.
 *
 * **Form-specific** ones belong to the new patient registration form alone. They are the two
 * properties that are invisible on screen and silent when wrong: that it declares pre-population
 * from the patient, and that it still carries the `Patient` element definitions the walk-in queue seeds a registration
 * from. Both survive a tidy-up that means no harm, and neither shows up as an error anywhere.
 *
 * The population rule is not universal. The other two fixtures populate from the practice's record
 * through `x-fhir-query` variables; this one populates only from `%patient`, which the walk-in's own
 * health record app supplies.
 * @author John Grimes
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  QUESTIONNAIRE_FIXTURES,
  loadQuestionnaireFixtures,
} from "../../ops/aidboxSetup";
import { isRenderableQuestionnaire } from "../../src/fhir/formsServer";
import { questionnaireDeclaresPopulation } from "../../src/fhir/populate";

import type { Questionnaire, QuestionnaireItem } from "fhir/r4";

/** Where the fixtures live, relative to the repository root. */
const FIXTURE_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../fixtures/questionnaires",
);

/** The walk-in form, which carries obligations the other two do not. */
const NEW_PATIENT_ID = "NewPatientRegistration";

/** The Patient elements the walk-in queue seeds a registration from. */
const SEEDED_DEFINITIONS = [
  "http://hl7.org/fhir/StructureDefinition/Patient#Patient.name.given",
  "http://hl7.org/fhir/StructureDefinition/Patient#Patient.name.family",
  "http://hl7.org/fhir/StructureDefinition/Patient#Patient.birthDate",
  "http://hl7.org/fhir/StructureDefinition/Patient#Patient.gender",
];

/** The codes `patientDetailsFromAnswers` will accept for a gender. */
const GENDER_CODES = ["female", "male", "other", "unknown"];

/**
 * Every item in a Questionnaire, at any depth.
 *
 * Follows `answer.item` as well as `item.item`: R4 allows a question nested under an *answer*, and
 * a walk that misses those would report a duplicate linkId as unique.
 * @param items the items to walk
 * @yields {QuestionnaireItem} each item, parents before children
 */
function* walkItems(
  items: readonly QuestionnaireItem[] | undefined,
): Generator<QuestionnaireItem> {
  for (const item of items ?? []) {
    yield item;
    yield* walkItems(item.item);
    for (const option of item.answerOption ?? []) {
      yield* walkItems(
        (option as { initial?: { item?: QuestionnaireItem[] } }).initial?.item,
      );
    }
  }
}

/**
 * Every item of one Questionnaire, flattened.
 * @param questionnaire the form to flatten
 * @returns its items, at every depth
 */
function allItems(questionnaire: Questionnaire): QuestionnaireItem[] {
  return [...walkItems(questionnaire.item)];
}

const fixtures = loadQuestionnaireFixtures(FIXTURE_DIRECTORY);

describe("the shipped Questionnaire fixtures", () => {
  // The loader is the only thing standing between a malformed file and a live Aidbox, and until
  // now nothing called it. Loading at module scope above means a parse failure fails this file.
  it("all load", () => {
    expect(fixtures).toHaveLength(QUESTIONNAIRE_FIXTURES.length);
  });

  describe.each(
    QUESTIONNAIRE_FIXTURES.map((fileName, index) => ({
      fileName,
      questionnaire: fixtures[index],
    })),
  )("$fileName", ({ fileName, questionnaire }) => {
    // The file name is the id, because `planSetup` PUTs to `/fhir/Questionnaire/<id>` while the
    // registry names files. A mismatch uploads a form under a name nobody will look for.
    it("is named after its id", () => {
      expect(questionnaire.id).toBe(fileName.replace(/\.json$/, ""));
    });

    /*
     * `buildInvitationBundle` throws without a canonical URL, which the mint turns into
     * `questionnaire-not-invitable` - so a fixture without one cannot be sent to anybody at all.
     */
    it("declares a canonical URL", () => {
      expect(questionnaire.url).toBeDefined();
      expect(questionnaire.url).toMatch(/^https?:\/\//);
    });

    // Walk-in review resolves the form back by `url` and `version` after the answers return, so a
    // fixture without a version renders its answers as bare linkIds.
    it("declares a version", () => {
      expect(questionnaire.version).toBeTruthy();
    });

    // `isRenderableQuestionnaire` filters out anything with no items, so a form that fails this
    // never appears in a picker at all.
    it("has items", () => {
      expect(isRenderableQuestionnaire(questionnaire)).toBe(true);
    });

    /*
     * An answer names its question by linkId and nothing else. Two questions sharing one is not a
     * validation error anywhere - it silently merges their answers, and the merge is what a
     * reviewer eventually sees.
     */
    it("uses each linkId once", () => {
      const linkIds = allItems(questionnaire).map((item) => item.linkId);
      const seen = new Set(linkIds);

      expect(linkIds).toHaveLength(seen.size);
    });

    // A dangling `enableWhen.question` hides an item forever, with nothing to say why.
    it("points every enableWhen at a question that exists", () => {
      const items = allItems(questionnaire);
      const known = new Set(items.map((item) => item.linkId));
      const dangling = items.flatMap((item) =>
        (item.enableWhen ?? [])
          .map((condition) => condition.question)
          .filter((question) => !known.has(question)),
      );

      expect(dangling).toEqual([]);
    });

    // `planSetup` strips `meta` before the PUT, so one here is a misunderstanding rather than a
    // setting - it would be silently discarded.
    it("carries no meta", () => {
      expect(questionnaire.meta).toBeUndefined();
    });

    // The file on disk is what gets uploaded, and `format:check` is in the gate.
    it("is formatted the way Prettier leaves it", () => {
      const onDisk = readFileSync(
        path.join(FIXTURE_DIRECTORY, fileName),
        "utf8",
      );

      expect(onDisk.endsWith("\n")).toBe(true);
      expect(onDisk).not.toContain("\t");
    });
  });

  describe("the new patient registration form", () => {
    const newPatient = fixtures.find(
      (questionnaire) => questionnaire.id === NEW_PATIENT_ID,
    );

    /*
     * The practice holds no record of a walk-in, but the walk-in's own health record app may, so the
     * form populates from `%patient` (issue #27). Dropping the extensions would not fail anywhere
     * visible: the patient's app would just report that nothing in their records matched.
     *
     * This app's own "fill this in from the record" toggle stays safe with the flag true. The
     * walk-in page never offers it, and `/request/:id` keeps it disabled until a patient is chosen.
     * Whether the expressions actually match anything is `tests/src/newPatientPopulation.test.ts`.
     */
    it("declares pre-population from the patient", () => {
      expect(newPatient).toBeDefined();
      expect(questionnaireDeclaresPopulation(newPatient)).toBe(true);
    });

    /*
     * The other silent one. The walk-in queue seeds the registration form by matching
     * `item.definition` against these four Patient elements. Rename or drop one and the seeding
     * quietly stops - no error, no failing render, just a receptionist back to retyping. Asserting
     * them here is what turns that into a failing test.
     */
    it("declares the Patient elements a registration is seeded from", () => {
      const declared = new Set(
        allItems(newPatient!)
          .map((item) => item.definition)
          .filter(
            (definition): definition is string => definition !== undefined,
          ),
      );

      for (const definition of SEEDED_DEFINITIONS) {
        expect(declared).toContain(definition);
      }
    });

    /*
     * Gender is offered as four inline options rather than resolved from a value set, so that a
     * stranger on a weak connection still gets a usable control - and so the seed can rely on the
     * codes arriving. A form that bound it to a value set instead would answer with, say, SNOMED
     * codes, which the seed would correctly refuse and silently drop.
     */
    it("offers gender as the four administrative-gender codes", () => {
      const gender = allItems(newPatient!).find(
        (item) => item.linkId === "gender",
      );

      expect(gender?.answerValueSet).toBeUndefined();
      expect(
        (gender?.answerOption ?? []).map((option) => option.valueCoding?.code),
      ).toEqual(GENDER_CODES);
    });
  });
});
