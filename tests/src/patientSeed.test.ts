/**
 * Reading a registration out of a walk-in's answers: `patientDetailsFromAnswers`.
 *
 * The walk-in queue opens `CreatePatientForm` for somebody the practice has never heard of. Before
 * this, the receptionist read the name, date of birth and gender off the rendered answers and typed
 * them back in - the paper problem moved one step, inside a feature whose premise is that reception
 * types nothing. This function is what fills those fields in, and every case below is a way it could
 * fill them in *wrongly*, which is worse than leaving them blank.
 *
 * ## Why the happy path runs against the real fixture
 *
 * A hand-built Questionnaire would assert that the function reads definitions I wrote in the same
 * file, which proves nothing about the form a walk-in will actually be handed. So the first case
 * loads `fixtures/questionnaires/NewPatientRegistration.json` from disk and answers it. Together
 * with `tests/ops/questionnaireFixtures.test.ts`, which asserts the four definitions are present,
 * that closes the loop: the fixture declares them, and this reads them.
 *
 * ## What "wrongly" means here
 *
 * Every value this produces is a claim typed by an unauthenticated stranger, shown to a reviewer in
 * an editable field. So the bar is not correctness of the claim - nobody can check that - but that
 * nothing is *invented*. A partial date that renders as an unexplained blank, a SNOMED gender code
 * the field cannot hold, a second "family name" question merged into the first: each is the function
 * asserting more than it was told, and each has a case below.
 * @author John Grimes
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type {
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
} from "fhir/r4";

import {
  buildPatient,
  patientDetailsFromAnswers,
  splitName,
  withTypedName,
  type PatientSeed,
} from "@/fhir/newPatient";

/** The base Patient StructureDefinition, the prefix of every definition under test. */
const PATIENT = "http://hl7.org/fhir/StructureDefinition/Patient#";

/** The shipped walk-in form, read from disk rather than rebuilt. */
const NEW_PATIENT_FORM = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../fixtures/questionnaires/NewPatientRegistration.json",
    ),
    "utf8",
  ),
) as Questionnaire;

/**
 * A Questionnaire wrapping the items a case is about.
 * @param items the items under test
 * @returns the Questionnaire
 */
function form(items: QuestionnaireItem[]): Questionnaire {
  return {
    resourceType: "Questionnaire",
    status: "draft",
    url: "http://example.org/Questionnaire/seed-test",
    item: items,
  };
}

/**
 * A completed response carrying the items a case is about.
 * @param items the answered items
 * @returns the response
 */
function answered(items: QuestionnaireResponseItem[]): QuestionnaireResponse {
  return {
    resourceType: "QuestionnaireResponse",
    status: "completed",
    questionnaire: "http://example.org/Questionnaire/seed-test",
    item: items,
  };
}

describe("patientDetailsFromAnswers", () => {
  // The whole point, against the form a walk-in is actually handed. If the fixture's definitions
  // ever drift from what this reads, this case is what says so.
  it("reads a registration off the shipped walk-in form", () => {
    const response: QuestionnaireResponse = {
      resourceType: "QuestionnaireResponse",
      status: "completed",
      questionnaire: NEW_PATIENT_FORM.url,
      item: [
        {
          linkId: "about-you",
          item: [
            { linkId: "name-given", answer: [{ valueString: "Sam" }] },
            { linkId: "name-family", answer: [{ valueString: "Rivers" }] },
            { linkId: "birth-date", answer: [{ valueDate: "1990-03-02" }] },
            {
              linkId: "gender",
              answer: [
                {
                  valueCoding: {
                    system: "http://hl7.org/fhir/administrative-gender",
                    code: "female",
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(patientDetailsFromAnswers(NEW_PATIENT_FORM, response)).toEqual({
      given: "Sam",
      family: "Rivers",
      birthDate: "1990-03-02",
      gender: "female",
    });
  });

  /*
   * The case the obvious signature could not express. Returning `NewPatientDetails`, which requires
   * a family name, would have thrown away a date of birth somebody did give because they skipped
   * the field above it.
   */
  it("keeps what was answered when the name was not", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "family",
          type: "string",
          definition: PATIENT + "Patient.name.family",
        },
        {
          linkId: "dob",
          type: "date",
          definition: PATIENT + "Patient.birthDate",
        },
      ]),
      answered([{ linkId: "dob", answer: [{ valueDate: "1990-03-02" }] }]),
    );

    expect(seed).toEqual({ birthDate: "1990-03-02" });
  });

  // Every other form in the catalogue declares none of these, and the caller has to be able to tell
  // "nothing to seed" from "an empty person".
  it("returns undefined for a form that declares nothing", () => {
    const seed = patientDetailsFromAnswers(
      form([{ linkId: "q1", type: "string", text: "How are you?" }]),
      answered([{ linkId: "q1", answer: [{ valueString: "Fine" }] }]),
    );

    expect(seed).toBeUndefined();
  });

  // Declared but unanswered is also nothing. `{ gender: undefined }` would read as a find.
  it("returns undefined when the declared questions went unanswered", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "gender",
          type: "choice",
          definition: PATIENT + "Patient.gender",
        },
        {
          linkId: "family",
          type: "string",
          definition: PATIENT + "Patient.name.family",
        },
      ]),
      answered([{ linkId: "gender", answer: [] }]),
    );

    expect(seed).toBeUndefined();
  });

  // No questionnaire is the normal state of a queue item whose canonical will not resolve, and it
  // must degrade to today's behaviour rather than to a guess.
  it("returns undefined without a questionnaire", () => {
    expect(patientDetailsFromAnswers(undefined, answered([]))).toBeUndefined();
  });

  /*
   * A repeating given-name item, joined so that `buildPatient` splits it back into the array FHIR
   * wants. Asserted as a round trip rather than as a string, because the string is a means: what
   * matters is the `given` array the record ends up holding.
   */
  it("round-trips repeated given names through buildPatient", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "given",
          type: "string",
          repeats: true,
          definition: PATIENT + "Patient.name.given",
        },
        {
          linkId: "family",
          type: "string",
          definition: PATIENT + "Patient.name.family",
        },
      ]),
      answered([
        {
          linkId: "given",
          answer: [{ valueString: "Jane" }, { valueString: "Louise" }],
        },
        { linkId: "family", answer: [{ valueString: "Citizen" }] },
      ]),
    );

    expect(seed?.given).toBe("Jane Louise");
    expect(
      buildPatient({ family: seed!.family!, given: seed!.given }).name,
    ).toEqual([{ family: "Citizen", given: ["Jane", "Louise"] }]);
  });

  /*
   * FHIR's `date` permits a year or a year and month; `<input type="date">` accepts neither. Seeding
   * one produces a field that renders blank with no way for the reviewer to know why.
   */
  it("drops a partial date of birth rather than seeding a blank field", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "dob",
          type: "date",
          definition: PATIENT + "Patient.birthDate",
        },
      ]),
      answered([{ linkId: "dob", answer: [{ valueDate: "1970" }] }]),
    );

    expect(seed).toBeUndefined();
  });

  it("takes the date out of a dateTime", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "dob",
          type: "date",
          definition: PATIENT + "Patient.birthDate",
        },
      ]),
      answered([
        { linkId: "dob", answer: [{ valueDateTime: "1970-03-04T00:00:00Z" }] },
      ]),
    );

    expect(seed).toEqual({ birthDate: "1970-03-04" });
  });

  /*
   * A form binding gender to a SNOMED value set answers with a code the field cannot hold. Seeding
   * nothing is right: the reviewer picks from the four on offer rather than being shown a value that
   * would be silently dropped on the way to the record.
   */
  it("ignores a gender code outside the value set", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "gender",
          type: "choice",
          definition: PATIENT + "Patient.gender",
        },
      ]),
      answered([
        {
          linkId: "gender",
          answer: [
            {
              valueCoding: {
                system: "http://snomed.info/sct",
                code: "248152002",
              },
            },
          ],
        },
      ]),
    );

    expect(seed).toBeUndefined();
  });

  it("accepts a gender given as text, in any case", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "gender",
          type: "choice",
          definition: PATIENT + "Patient.gender",
        },
      ]),
      answered([{ linkId: "gender", answer: [{ valueString: "FEMALE" }] }]),
    );

    expect(seed).toEqual({ gender: "female" });
  });

  // A versioned canonical is legal, and splitting on `#` without stripping it would seed nothing
  // while looking entirely correct.
  it("matches a definition whose canonical carries a version", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "dob",
          type: "date",
          definition:
            "http://hl7.org/fhir/StructureDefinition/Patient|4.0.1#Patient.birthDate",
        },
      ]),
      answered([{ linkId: "dob", answer: [{ valueDate: "1990-03-02" }] }]),
    );

    expect(seed).toEqual({ birthDate: "1990-03-02" });
  });

  // No fragment names the Patient root - the whole resource, not a field. Treating it as a wildcard
  // would let one item seed whatever happened to be checked first.
  it("ignores a definition with no element fragment", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "patient",
          type: "string",
          definition: "http://hl7.org/fhir/StructureDefinition/Patient",
        },
      ]),
      answered([
        { linkId: "patient", answer: [{ valueString: "Sam Rivers" }] },
      ]),
    );

    expect(seed).toBeUndefined();
  });

  // A profile's element id can carry a slice meaning something narrower than the element it hangs
  // off. Matching one would be asserting we had read a profile we have not.
  it("ignores a definition on a profile rather than the base resource", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "family",
          type: "string",
          definition:
            "http://hl7.org.au/fhir/StructureDefinition/au-patient#Patient.name.family",
        },
      ]),
      answered([{ linkId: "family", answer: [{ valueString: "Rivers" }] }]),
    );

    expect(seed).toBeUndefined();
  });

  /*
   * A form may legitimately ask for a family name twice - once for the patient, once for a previous
   * name. Document order decides, because merging the two would invent a person who does not exist.
   */
  it("takes the first declared question when two name the same element", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "current",
          type: "string",
          definition: PATIENT + "Patient.name.family",
        },
        {
          linkId: "previous",
          type: "string",
          definition: PATIENT + "Patient.name.family",
        },
      ]),
      answered([
        { linkId: "current", answer: [{ valueString: "Rivers" }] },
        { linkId: "previous", answer: [{ valueString: "Okonkwo" }] },
      ]),
    );

    expect(seed).toEqual({ family: "Rivers" });
  });

  // R4 nests a question under an *answer* as well as under an item, and the renderer emits that
  // shape for questions hanging off a choice. A walk that missed it would report a form unanswered.
  it("finds an answer nested under another answer", () => {
    const seed: PatientSeed | undefined = patientDetailsFromAnswers(
      form([
        {
          linkId: "has-name",
          type: "boolean",
          item: [
            {
              linkId: "family",
              type: "string",
              definition: PATIENT + "Patient.name.family",
            },
          ],
        },
      ]),
      answered([
        {
          linkId: "has-name",
          answer: [
            {
              valueBoolean: true,
              item: [{ linkId: "family", answer: [{ valueString: "Rivers" }] }],
            },
          ],
        },
      ]),
    );

    expect(seed).toEqual({ family: "Rivers" });
  });

  // Whitespace is not an answer, and a blank string seeded into a required field is worse than an
  // empty one: it looks answered.
  it("ignores a blank answer", () => {
    const seed = patientDetailsFromAnswers(
      form([
        {
          linkId: "family",
          type: "string",
          definition: PATIENT + "Patient.name.family",
        },
      ]),
      answered([
        { linkId: "family", answer: [{ valueString: " ".repeat(3) }] },
      ]),
    );

    expect(seed).toBeUndefined();
  });
});

describe("splitName", () => {
  /*
   * The picker splits the search box's text when somebody types over a seeded name. The heuristic
   * is wrong for a large part of the world and the form says so; what matters here is that it is
   * wrong predictably, and that the family name - the field `createPatient` throws without - is
   * never the empty one.
   */
  it("takes the last token as the family name", () => {
    expect(splitName("Jane Louise Citizen")).toEqual({
      given: "Jane Louise",
      family: "Citizen",
    });
  });

  it("makes a single token the family name, not the given name", () => {
    expect(splitName("Citizen")).toEqual({ given: "", family: "Citizen" });
  });

  it("returns two empty halves for nothing at all", () => {
    expect(splitName(" ".repeat(3))).toEqual({ given: "", family: "" });
  });
});

describe("withTypedName", () => {
  /*
   * The case that makes this a function rather than a spread. A receptionist who has the answers
   * for "Jane Citizen" on screen and types "Smith" into the search box is looking for somebody
   * called Smith. Merging field by field would open a registration for **Jane Smith** - a person
   * who does not exist, whom nobody mentioned, and whose given name came from a different human
   * being's form.
   */
  it("replaces both halves of the name together", () => {
    expect(
      withTypedName(
        { given: "Jane", family: "Citizen", birthDate: "1990-03-02" },
        "Smith",
      ),
    ).toEqual({ given: "", family: "Smith", birthDate: "1990-03-02" });
  });

  // The date of birth and the gender are not things a search box says anything about, so they
  // survive a typed name rather than being cleared by it.
  it("keeps everything the name says nothing about", () => {
    expect(
      withTypedName({ family: "Citizen", gender: "female" }, "Jane Smith"),
    ).toEqual({ given: "Jane", family: "Smith", gender: "female" });
  });

  it("leaves the seed alone when nothing has been typed", () => {
    const seed = { given: "Sam", family: "Rivers" };

    expect(withTypedName(seed, " ".repeat(3))).toEqual(seed);
  });

  // No answers and no typing is the ordinary per-patient review, where the form opens blank.
  it("is undefined when there is neither a seed nor a typed name", () => {
    expect(withTypedName(undefined, "")).toBeUndefined();
  });

  // A typed name with no seed behind it is how the picker has always worked.
  it("builds a seed from a typed name alone", () => {
    expect(withTypedName(undefined, "Jane Citizen")).toEqual({
      given: "Jane",
      family: "Citizen",
    });
  });
});
