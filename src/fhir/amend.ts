import type { Meta, Provenance, QuestionnaireResponse } from "fhir/r4";

import {
  PATIENT_ASSERTED_SECURITY,
  PROVENANCE_PARTICIPANT_TYPE,
} from "@/link/exchange";

/**
 * Amending answers somebody else gave — as a new resource, never as an edit.
 *
 * `ReviewResponse` renders an incoming response read-only, and this is why that is a design decision
 * rather than a missing feature. Answers arriving over the encrypted channel carry two claims about
 * who said them: `meta.security = PATAST`, and a `Provenance` naming the patient as author. Editing
 * the answers in place and saving them under those would file words the reviewer typed as words the
 * patient asserted, and nothing downstream could tell the two apart.
 *
 * So the original is stored exactly as it arrived, and an amendment becomes a **second**
 * QuestionnaireResponse authored by the reviewer, joined to the first by a `Provenance` with
 * `entity.role = revision`. Two resources, two authors, and a record that says which is which.
 *
 * The join has to be a Provenance because R4 offers nothing better: `QuestionnaireResponse.partOf`
 * takes only `Procedure | Observation` and `basedOn` only `CarePlan | ServiceRequest`, so neither can
 * point at the response being revised.
 */

/**
 * v3 `UPDATE` — displayed as "revise", which is exactly what this is.
 *
 * `Provenance.activity` binds to ProvenanceActivityType only as an example, so this is a choice
 * rather than a requirement; v3-DataOperation is the set the base spec itself illustrates with.
 */
export const PROVENANCE_ACTIVITY_UPDATE = {
  system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
  code: "UPDATE",
  display: "revise",
} as const;

/**
 * Stands in for the amended response's `target` until it has been created and has a real id.
 *
 * `Provenance.target` is 1..*, so it cannot be left off while the resource is being built, and the id
 * it should point at does not exist until the POST returns. {@link submitAmendment} rewrites it.
 */
export const AMENDMENT_TARGET_PLACEHOLDER = "urn:uuid:amended-response";

export interface Amendment {
  response: QuestionnaireResponse;
  provenance: Provenance;
}

export interface BuildAmendmentOptions {
  /** The response as it was stored — the thing being revised, not the thing that arrived. */
  original: QuestionnaireResponse;
  /**
   * The original's id **on the server this amendment is being written to**.
   *
   * Per-server, because a response written to several destinations gets a different id from each, and
   * a reference to one server's id means nothing on another.
   */
  originalResponseId: string;
  /** The edited answers, as read out of the renderer. Only `item` is taken from these. */
  edited: QuestionnaireResponse;
  /** Who is amending. Required — an unattributed amendment is the thing this module exists to prevent. */
  amender: string;
  /**
   * The amender as a FHIR reference, e.g. `Practitioner/123`, when a SMART launch established who they
   * are. Optional even though an amendment now requires a launch: `fhirUser` is a scope like any other
   * and a server may decline to grant it, so a typed name remains the fallback.
   *
   * When present it is the difference between an attribution and a claim. `who.display` alone records
   * a string somebody typed into a box; `who.reference` records a person the authorisation server
   * vouched for, which is what makes the Provenance worth keeping. Both are written when both are
   * known — the reference identifies, the display stays readable if the reference later cannot be
   * resolved.
   */
  amenderReference?: string;
  recorded?: string;
}

/**
 * Drop the patient-asserted label, and only that.
 *
 * An amended document is no longer wholly the patient's words, so carrying `PATAST` across would
 * assert something false about the parts the reviewer changed. Removing it slightly understates the
 * other direction — most of the content usually *is* patient-asserted — but that error is recoverable
 * and the other is not: the Provenance points at the original, which still carries the label.
 *
 * Everything else in `meta` survives, for the same reason `asNewResource` keeps it: `profile` and
 * `tag` are claims about the content rather than the sender's bookkeeping.
 * @param meta
 */
function withoutPatientAsserted(meta: Meta | undefined): Meta | undefined {
  if (!meta) {
    return undefined;
  }

  const { security, ...rest } = meta;
  const kept = (security ?? []).filter(
    (coding) =>
      !(
        coding.system === PATIENT_ASSERTED_SECURITY.system &&
        coding.code === PATIENT_ASSERTED_SECURITY.code
      ),
  );

  const next: Meta = kept.length > 0 ? { ...rest, security: kept } : rest;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Build the amended response and the Provenance that says what it revises.
 *
 * The edited answers supply `item` and nothing else. Which questionnaire and which patient are carried
 * from the stored original, so an amendment cannot quietly repoint the answers at a different form or
 * a different person — the renderer's store is seeded from the original, but it is a module-level
 * singleton and not something to trust with the identity of the record.
 * @param options
 */
export function buildAmendment(options: BuildAmendmentOptions): Amendment {
  const { original, originalResponseId, edited, amender, amenderReference } =
    options;

  /** `who` is 1..1 on a Provenance agent, so this is built once and used for both places it appears. */
  const who = amenderReference
    ? { reference: amenderReference, display: amender }
    : { display: amender };
  const recorded = options.recorded ?? new Date().toISOString();
  const { id: _id, meta, ...withoutIdentity } = original;
  const keptMeta = withoutPatientAsserted(meta);

  const response: QuestionnaireResponse = {
    ...withoutIdentity,
    ...(keptMeta ? { meta: keptMeta } : {}),
    item: edited.item,
    status: "completed",
    authored: recorded,
    /*
     * `author` is who *recorded* the answers and `source` is who *answered* them, and the distinction
     * is the whole point here. The amender becomes the author of this version; `source` rides through
     * untouched, because the patient still answered the questions.
     */
    author: who,
  };

  const provenance: Provenance = {
    resourceType: "Provenance",
    target: [{ reference: AMENDMENT_TARGET_PLACEHOLDER }],
    recorded,
    activity: { coding: [{ ...PROVENANCE_ACTIVITY_UPDATE }] },
    agent: [
      {
        type: {
          coding: [
            {
              system: PROVENANCE_PARTICIPANT_TYPE,
              code: "author",
              display: "Author",
            },
          ],
        },
        who,
      },
    ],
    entity: [
      {
        role: "revision",
        what: { reference: `QuestionnaireResponse/${originalResponseId}` },
      },
    ],
  };

  return { response, provenance };
}
