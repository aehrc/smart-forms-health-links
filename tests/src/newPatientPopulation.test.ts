/**
 * Filling the walk-in registration form from the patient's own record.
 *
 * The practice holds nothing on a walk-in, but the walk-in's health record app may hold a great deal:
 * their `Patient`, sitting in a local vault on the phone that scanned the poster. Issue #27 added
 * `initialExpression`s to `NewPatientRegistration.json` so an app like that can run SDC `$populate`
 * against `%patient` and hand over a form that is already filled in.
 *
 * `questionnaireFixtures.test.ts` asserts the form *declares* population. That proves nothing about
 * whether a single expression matches anything - every one of them could name the wrong element and
 * the flag would still be true. So this runs the real form through `@aehrc/sdc-populate`, the engine
 * this repo already uses, against an Australian patient shaped the way AU Base shapes one, and checks
 * the answers that come out.
 *
 * ## The cases that would fail quietly
 *
 * - **The Medicare number.** AU Base allows the card number and the IRN in one 11-digit value. The
 *   form asks for them separately and its number field accepts exactly ten digits, so an unsplit value
 *   would arrive as an answer the form itself calls invalid.
 * - **Gender and state.** Both are `choice` items, and the record holds a plain code or plain text.
 *   The engine has to turn that into one of the item's codings, by `answerOption` for gender and by
 *   expanding the value set for state. A miss leaves the question blank with no error.
 * - **The round trip.** Reception's walk-in queue seeds a registration from these answers through
 *   `item.definition`. Pre-population must hand that seeding exactly what the record said.
 * @author Clinton Gillespie
 */

import {
  populateQuestionnaire,
  type FetchTerminologyCallback,
} from "@aehrc/sdc-populate";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type {
  Patient,
  Questionnaire,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
  ValueSet,
} from "fhir/r4";

import { buildPatient, patientDetailsFromAnswers } from "@/fhir/newPatient";

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

const STATES =
  "https://healthterminologies.gov.au/fhir/CodeSystem/australian-states-territories-2";

/** A walk-in as their own health record app might hold them. */
const PATIENT: Patient = {
  resourceType: "Patient",
  id: "vault-patient",
  identifier: [
    {
      system: "http://ns.electronichealth.net.au/id/medicare-number",
      value: "29501012341",
      period: { end: "2028-05" },
    },
    {
      system: "http://ns.electronichealth.net.au/id/dva",
      value: "NX123456",
    },
  ],
  name: [
    { use: "usual", given: ["Kim"] },
    { use: "official", family: "Nguyen", given: ["Kimberly", "Anne"] },
  ],
  telecom: [
    { system: "phone", use: "home", value: "03 9123 4567" },
    { system: "phone", use: "mobile", value: "0412 345 678" },
    { system: "email", value: "kim@example.org" },
  ],
  gender: "female",
  birthDate: "1984-03-07",
  address: [
    { use: "work", line: ["1 Office Road"], city: "Docklands", state: "VIC" },
    {
      use: "home",
      line: ["Unit 4", "12 Example Street"],
      city: "Carlton",
      state: "VIC",
      postalCode: "3053",
    },
  ],
  contact: [
    {
      relationship: [{ text: "Sister" }],
      name: { given: ["Lee"], family: "Nguyen" },
      telecom: [{ system: "phone", value: "0498 765 432" }],
    },
  ],
};

/**
 * Stands in for the terminology server, so the state question resolves offline.
 * @param query the `$expand` query the engine built
 * @returns a one-code expansion of the states value set
 */
const terminology: FetchTerminologyCallback = (query) => {
  expect(query).toContain("australian-states-territories-2");
  const expansion: ValueSet = {
    resourceType: "ValueSet",
    status: "active",
    expansion: {
      timestamp: "2026-10-19T00:00:00Z",
      contains: [{ system: STATES, code: "VIC", display: "Victoria" }],
    },
  };
  return Promise.resolve(expansion);
};

/**
 * Populate the shipped form from a patient, with no record server behind it.
 * @param patient the launch context
 * @returns the populated response
 */
async function populate(patient: Patient): Promise<QuestionnaireResponse> {
  const { populateSuccess, populateResult } = await populateQuestionnaire({
    questionnaire: NEW_PATIENT_FORM,
    patient,
    // The form declares no queries, so any read at all is a defect worth failing on.
    fetchResourceCallback: (query) =>
      Promise.reject(new Error(`unexpected record read: ${query}`)),
    fetchResourceRequestConfig: { sourceServerUrl: "http://vault.invalid" },
    fetchTerminologyCallback: terminology,
    fetchTerminologyRequestConfig: {
      terminologyServerUrl: "http://terminology.invalid",
    },
    timeoutMs: 5000,
  });

  expect(populateSuccess).toBe(true);
  return populateResult!.populatedResponse;
}

/**
 * Every answer in a response, by linkId, however deeply grouped.
 * @param response the populated response
 * @returns the answers
 */
function answersByLinkId(
  response: QuestionnaireResponse,
): Map<string, QuestionnaireResponseItemAnswer[]> {
  const answers = new Map<string, QuestionnaireResponseItemAnswer[]>();
  const walk = (items: QuestionnaireResponseItem[] | undefined) => {
    for (const item of items ?? []) {
      if (item.answer?.length) {
        answers.set(item.linkId, item.answer);
      }
      walk(item.item);
    }
  };
  walk(response.item);
  return answers;
}

describe("pre-populating the walk-in registration form", () => {
  it("fills the demographic, contact, Medicare, DVA and emergency questions", async () => {
    const answers = answersByLinkId(await populate(PATIENT));
    const value = (linkId: string) => {
      const [answer] = answers.get(linkId) ?? [];
      return (
        answer?.valueString ??
        answer?.valueDate ??
        answer?.valueBoolean ??
        answer?.valueCoding?.code
      );
    };

    expect(value("name-given")).toBe("Kimberly Anne");
    expect(value("name-family")).toBe("Nguyen");
    expect(value("name-preferred")).toBe("Kim");
    expect(value("birth-date")).toBe("1984-03-07");
    expect(value("gender")).toBe("female");

    // The home address, not the first one listed.
    expect(value("address-line")).toBe("Unit 4\n12 Example Street");
    expect(value("address-suburb")).toBe("Carlton");
    expect(value("address-state")).toBe("VIC");
    expect(answers.get("address-state")?.[0]?.valueCoding?.system).toBe(STATES);
    expect(value("address-postcode")).toBe("3053");

    expect(value("phone-mobile")).toBe("0412 345 678");
    expect(value("phone-other")).toBe("03 9123 4567");
    expect(value("email")).toBe("kim@example.org");

    expect(value("medicare-number")).toBe("2950101234");
    expect(value("medicare-irn")).toBe("1");
    expect(value("medicare-expiry")).toBe("05/2028");
    expect(value("has-dva")).toBe(true);
    expect(value("dva-number")).toBe("NX123456");

    expect(value("emergency-name")).toBe("Lee Nguyen");
    expect(value("emergency-relationship")).toBe("Sister");
    expect(value("emergency-phone")).toBe("0498 765 432");
  });

  /*
   * A ten-digit Medicare value is the card number with no IRN, which AU Base also allows. The IRN
   * question must stay blank rather than receive an empty string.
   */
  it("leaves the IRN blank when the record holds only the card number", async () => {
    const answers = answersByLinkId(
      await populate({
        ...PATIENT,
        identifier: [
          {
            system: "http://ns.electronichealth.net.au/id/medicare-number",
            value: "2950101234",
          },
        ],
      }),
    );

    expect(answers.get("medicare-number")?.[0]?.valueString).toBe("2950101234");
    expect(answers.has("medicare-irn")).toBe(false);
    expect(answers.has("medicare-expiry")).toBe(false);
    expect(answers.get("has-dva")?.[0]?.valueBoolean).toBe(false);
  });

  it("answers nothing it cannot read from a near-empty record", async () => {
    const answers = answersByLinkId(
      await populate({ resourceType: "Patient", id: "sparse" }),
    );

    expect([...answers.keys()]).toEqual(["has-dva"]);
  });

  /*
   * The two directions meet here. Pre-population reads the record into the answers; reception's
   * seeding reads the answers back into a registration through `item.definition`. What comes out
   * must be what went in - and nothing more, because the Medicare and DVA numbers pre-filled above
   * are answers for staff to check against a card, never identifiers on the practice record.
   */
  it("hands reception's seeding exactly what the record said, without identifiers", async () => {
    const response = await populate(PATIENT);

    const seed = patientDetailsFromAnswers(NEW_PATIENT_FORM, response);
    expect(seed).toEqual({
      given: "Kimberly Anne",
      family: "Nguyen",
      birthDate: "1984-03-07",
      gender: "female",
    });

    const registered = buildPatient({ ...seed, family: seed!.family! });
    expect(registered.identifier).toBeUndefined();
  });
});
