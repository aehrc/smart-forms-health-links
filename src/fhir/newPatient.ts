import type {
  Patient,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
} from "fhir/r4";

/**
 * Building a Patient from what a reviewer typed.
 *
 * Reached when answers come back for somebody the destination server has never heard of. That is not
 * an edge case: a request can go to a walk-in, a new referral, or anyone the practice has not yet
 * registered, and until now the reviewer's only remaining option was to save the answers with no
 * subject at all — filing them against nobody, permanently.
 *
 * **No channel carries a Patient.** `parseResponseBundle` extracts only the QuestionnaireResponse,
 * its Task and its Provenance, and a `Patient` entry in the bundle is dropped on the floor. So
 * nothing here is ever taken from a resource somebody else built.
 *
 * What *can* arrive is answers. A form that asks for a name, a date of birth and a gender produces
 * those as answers to questions, and {@link patientDetailsFromAnswers} reads them - which is how the
 * walk-in queue opens its registration form filled in rather than blank. That is a change of degree
 * and not of kind: an answer is a claim typed by an unauthenticated stranger, not a record. It is
 * shown to a human in editable fields and confirmed before anything is written, exactly as a name
 * split out of `subject.display` always was.
 *
 * The builder is deliberately conservative about what it asserts. See {@link buildPatient}.
 */

export interface NewPatientDetails {
  /**
   * Required. A Patient with no family name is a record nobody finds again — `searchPatients` sorts
   * by `family` and searches by name, so one without it is invisible to the very picker that would
   * have to find it next time.
   */
  family: string;
  /** Space-separated on input; split into the `given` array. */
  given?: string;
  /** `YYYY-MM-DD`. */
  birthDate?: string;
  gender?: Patient["gender"];
}

/**
 * Split a display name into given and family parts.
 *
 * Last whitespace-separated token becomes the family name, the rest the given names. This heuristic
 * is **wrong for a large fraction of the world's names**, and is only defensible because the caller
 * renders both halves as editable fields with the source string shown beside them. It is a starting
 * point for a human to correct, never a conclusion.
 *
 * A single token becomes the family name, since that is the field that must not be empty.
 * @param display
 */
export function splitName(display: string): { given: string; family: string } {
  const parts = display.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { given: "", family: "" };
  }

  return {
    given: parts.slice(0, -1).join(" "),
    family: parts.at(-1) ?? "",
  };
}

/**
 * The Patient resource to create. Four things it deliberately does *not* carry:
 *
 *  - **No `identifier`.** An identifier is the one field where a typo makes a false claim that
 *    silently mis-matches records elsewhere. This app has no HI Service lookup and no authenticated
 *    user, so it has no business minting one.
 *  - **No `name.text`.** `patientDisplay` prefers `text` and falls back to the joined parts, so
 *    omitting it costs nothing to display and removes a real data-quality trap: `text` and the parts
 *    disagreeing after somebody edits one of them.
 *  - **No `name.use: 'official'`.** That is a provenance claim nothing here can support.
 *  - **No `active`.** Never assert a default nobody chose.
 *
 * Blank optional fields are **omitted rather than sent empty**. A cleared `<input type="date">` yields
 * `''`, which is not a FHIR `date`, and `gender` has a required binding — either would be rejected by
 * a validating server, and silently stored by a lenient one.
 * @param details
 */
export function buildPatient(details: NewPatientDetails): Patient {
  const family = details.family.trim();
  const given = (details.given ?? "").trim().split(/\s+/).filter(Boolean);
  const birthDate = (details.birthDate ?? "").trim();
  const gender = details.gender;

  return {
    resourceType: "Patient",
    name: [{ family, ...(given.length > 0 ? { given } : {}) }],
    ...(birthDate === "" ? {} : { birthDate }),
    ...(gender ? { gender } : {}),
  };
}

/**
 * Canonical of the base Patient StructureDefinition, the prefix of every definition read below.
 *
 * Only the base HL7 resource is matched, never a profile. `Questionnaire.item.definition` names an
 * `ElementDefinition` by its **id**, and under a profile an id can carry a slice
 * (`Patient.identifier:medicare`) that means something narrower than the element it hangs off.
 * Matching those would be asserting we understood a profile we have never read.
 */
const PATIENT_DEFINITION = "http://hl7.org/fhir/StructureDefinition/Patient";

/** Which of a Patient's elements an item answers, for the four a registration needs. */
const SEEDED_ELEMENTS = {
  "Patient.name.given": "given",
  "Patient.name.family": "family",
  "Patient.birthDate": "birthDate",
  "Patient.gender": "gender",
} as const;

/** The field of a {@link PatientSeed} one definition fills. */
type SeededField = (typeof SEEDED_ELEMENTS)[keyof typeof SEEDED_ELEMENTS];

/** The codes `Patient.gender` is bound to. Anything else is not a gender this can seed. */
const GENDER_CODES = new Set(["male", "female", "other", "unknown"]);

/** A full FHIR `date`. Partials are legal in FHIR and useless to `<input type="date">`. */
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What the answers suggest about who this is.
 *
 * Every field is optional, and that is the difference between this and {@link NewPatientDetails}.
 * `NewPatientDetails` is the input to a write, so it requires the family name `createPatient` would
 * throw without. This is what somebody typed into a form before anybody checked it - the name field
 * may well be the one they skipped, and throwing away a date of birth they *did* give because of it
 * would be losing the only thing we had.
 */
export interface PatientSeed {
  /** Given names, space separated, as {@link buildPatient} expects them. */
  given?: string;
  family?: string;
  /** `YYYY-MM-DD`, never a partial date. */
  birthDate?: string;
  gender?: Patient["gender"];
}

/**
 * Which Patient element an item says it answers, if it says at all.
 *
 * Two spellings are rejected rather than guessed at. A canonical with no `#` names the root of the
 * StructureDefinition - the whole Patient, not a field - so it is not a wildcard. A fragment naming
 * an element this does not seed is simply not ours. A `|version` before the fragment is legal and is
 * stripped, so `…/Patient|4.0.1#Patient.birthDate` matches rather than silently seeding nothing.
 * @param definition the item's `definition`, when it has one
 * @returns the seed field this item fills, or undefined
 */
function seededField(definition: string | undefined): SeededField | undefined {
  if (definition === undefined) {
    return undefined;
  }
  const hash = definition.indexOf("#");
  if (hash === -1) {
    return undefined;
  }
  const base = definition.slice(0, hash).split("|", 1)[0];
  if (base !== PATIENT_DEFINITION) {
    return undefined;
  }
  return SEEDED_ELEMENTS[
    definition.slice(hash + 1) as keyof typeof SEEDED_ELEMENTS
  ];
}

/**
 * Every item of a Questionnaire, parents before children, in document order.
 *
 * Document order is what makes "the first item carrying this definition wins" a rule rather than an
 * accident, and it matters: a form may legitimately cite `Patient.name.family` twice - once for the
 * patient and once for a previous name - and merging the two would invent a person.
 * @param items the items to walk
 * @yields {QuestionnaireItem} each item
 */
function* questionnaireItems(
  items: readonly QuestionnaireItem[] | undefined,
): Generator<QuestionnaireItem> {
  for (const item of items ?? []) {
    yield item;
    yield* questionnaireItems(item.item);
  }
}

/**
 * Every answer given against one linkId, in document order.
 *
 * Follows `answer.item` as well as `item.item`, because R4 nests a question under an *answer* as
 * well as under an item, and the renderer emits that shape for questions hanging off a choice. A
 * walk that missed those would report a form as unanswerable that a filler had answered.
 * @param items the response items to walk
 * @param linkId the question to collect
 * @yields {QuestionnaireResponseItemAnswer} each answer to it
 */
function* answersFor(
  items: readonly QuestionnaireResponseItem[] | undefined,
  linkId: string,
): Generator<QuestionnaireResponseItemAnswer> {
  for (const item of items ?? []) {
    if (item.linkId === linkId) {
      yield* item.answer ?? [];
    }
    yield* answersFor(item.item, linkId);
    for (const answer of item.answer ?? []) {
      yield* answersFor(answer.item, linkId);
    }
  }
}

/**
 * The text of an answer, for the fields that are plain strings.
 * @param answer one answer
 * @returns the trimmed string, or undefined when it carries none
 */
function answerText(
  answer: QuestionnaireResponseItemAnswer,
): string | undefined {
  const value = answer.valueString?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * A full date from an answer, or nothing.
 *
 * FHIR's `date` permits `1970` and `1970-03`, and `<input type="date">` refuses both - so seeding a
 * partial produces a field that renders blank and that the reviewer cannot explain or correct.
 * Dropping it is the honest outcome.
 * @param answer one answer
 * @returns `YYYY-MM-DD`, or undefined
 */
function answerDate(
  answer: QuestionnaireResponseItemAnswer,
): string | undefined {
  const value = answer.valueDate ?? answer.valueDateTime?.slice(0, 10);
  return value !== undefined && FULL_DATE.test(value) ? value : undefined;
}

/**
 * A gender code from an answer, validated rather than trusted.
 *
 * The code is checked and the system ignored. A form binding gender to a SNOMED value set answers
 * with codes this does not recognise, and seeding nothing is right: the reviewer picks from the four
 * the field offers rather than being shown a value the record cannot hold.
 * @param answer one answer
 * @returns the administrative-gender code, or undefined
 */
function answerGender(
  answer: QuestionnaireResponseItemAnswer,
): Patient["gender"] | undefined {
  const code = (answer.valueCoding?.code ?? answer.valueString)
    ?.trim()
    .toLowerCase();
  return code !== undefined && GENDER_CODES.has(code)
    ? (code as Patient["gender"])
    : undefined;
}

/**
 * Read what a completed form says about who filled it in.
 *
 * The walk-in case is the reason this exists. Answers arrive from somebody the practice has never
 * heard of, and until a human attaches them to a patient they belong to nobody - so the receptionist
 * was reading the name, date of birth and gender off the rendered form and typing them back in. That
 * is the paper problem moved one step, in a feature whose whole premise is that reception types
 * nothing.
 *
 * **Matched on `Questionnaire.item.definition`, not on linkIds.** `definition` is FHIR's own way for
 * an item to say which element it answers, so a form that declares it is seeded here whoever wrote
 * it, and this module stays ignorant of any particular form's question names. A linkId convention
 * would be the same coupling with none of the visibility: renaming a question would stop the seeding
 * silently, where a missing definition is asserted by
 * `tests/ops/questionnaireFixtures.test.ts`.
 *
 * **Best effort, and never a conclusion.** Anything unreadable is left out rather than guessed at,
 * and what comes back opens an editable form for a human to confirm. `undefined` means the form
 * declared nothing this understands, or declared it and nobody answered - which is every other form
 * in the catalogue, and is why the caller must fall back rather than show an empty registration.
 * @param questionnaire the form the answers were given against, when it could be resolved
 * @param response the completed answers
 * @returns what the answers say, or undefined when they say nothing this can read
 * @example
 * const seed = patientDetailsFromAnswers(questionnaire, response);
 * // { given: "Sam", family: "Rivers", birthDate: "1990-03-02", gender: "female" }
 */
export function patientDetailsFromAnswers(
  questionnaire: Questionnaire | undefined,
  response: QuestionnaireResponse,
): PatientSeed | undefined {
  if (questionnaire === undefined) {
    return undefined;
  }

  const seed: PatientSeed = {};
  for (const item of questionnaireItems(questionnaire.item)) {
    const field = seededField(item.definition);
    // First item in document order that both declares the element and was answered wins. A later
    // one is a second question about the same thing, not a correction to this one.
    if (field === undefined || seed[field] !== undefined) {
      continue;
    }
    const answers = [...answersFor(response.item, item.linkId)];

    if (field === "given") {
      /*
       * Joined with single spaces, because `buildPatient` splits `given` on whitespace back into
       * the array FHIR wants - so a repeating item answered "Jane" and "Louise" round-trips to
       * `given: ["Jane", "Louise"]` exactly.
       */
      const given = answers
        .map((answer) => answerText(answer))
        .filter((value): value is string => value !== undefined)
        .join(" ");
      if (given !== "") {
        seed.given = given;
      }
      continue;
    }

    // Everything else takes the first readable answer. A second family name or date of birth is an
    // authoring mistake rather than data, and picking between them is not this function's business.
    if (field === "gender") {
      // Assigned only when there is one: `seed.gender = undefined` would leave the key present,
      // and an all-undefined seed would then read as "we found something" to the caller.
      const gender = answers
        .map((answer) => answerGender(answer))
        .find((value) => value !== undefined);
      if (gender !== undefined) {
        seed.gender = gender;
      }
      continue;
    }
    const read = field === "birthDate" ? answerDate : answerText;
    const value = answers
      .map((answer) => read(answer))
      .find((candidate) => candidate !== undefined);
    if (value !== undefined) {
      seed[field] = value;
    }
  }

  return Object.keys(seed).length === 0 ? undefined : seed;
}

/**
 * Apply a name somebody typed over a seed read from the answers.
 *
 * What they just typed beats what arrived with the answers, because it is the more recent statement
 * of who they are looking for - but only about the *name*. A search box says nothing about a date of
 * birth or a gender, so those carry through untouched.
 *
 * **Both halves of the name are replaced together**, and that is the whole reason this is a function
 * rather than a spread. Merging field by field would let "Smith", typed over a seed of "Jane
 * Citizen", produce Jane Smith - a person who does not exist and whom nobody asked about. Replacing
 * the name whole has no such state: the result is either entirely what they typed or entirely what
 * was answered.
 * @param seed what the answers said, when they said anything
 * @param typed what the user has typed into the search box
 * @returns the seed to open a registration form with
 * @example
 * withTypedName({ given: "Jane", family: "Citizen", gender: "female" }, "Smith");
 * // { given: "", family: "Smith", gender: "female" }
 */
export function withTypedName(
  seed: PatientSeed | undefined,
  typed: string,
): PatientSeed | undefined {
  const trimmed = typed.trim();
  if (trimmed === "") {
    return seed;
  }
  return { ...seed, ...splitName(trimmed) };
}
