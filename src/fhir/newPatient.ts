import type { Patient } from "fhir/r4";

/**
 * Building a Patient from what a reviewer typed.
 *
 * Reached when answers come back for somebody the destination server has never heard of. That is not
 * an edge case: a request can go to a walk-in, a new referral, or anyone the practice has not yet
 * registered, and until now the reviewer's only remaining option was to save the answers with no
 * subject at all — filing them against nobody, permanently.
 *
 * **Everything here is typed by a human**, and that is a property of the wire format rather than a
 * shortcut. No channel carries demographics: `parseResponseBundle` extracts only the
 * QuestionnaireResponse, its Task and its Provenance, and a `Patient` entry in the bundle is dropped
 * on the floor. The most that can travel is a free-text name in `subject.display`, which is why that
 * is the one field this seeds from.
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
