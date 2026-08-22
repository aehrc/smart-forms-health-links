/**
 * Reading the server-side end state with operator credentials.
 *
 * Every scenario in `quickstart.md` finishes with a claim about what the launched server now
 * holds, and that is the claim worth making: the browser saying "accepted" is the app's account
 * of itself, whereas a FHIR search performed with credentials the app never sees is independent
 * of it. So the specs assert through here rather than through the UI.
 *
 * The credentials are the operator API client `ops/aidboxSetup.ts` uses - HTTP Basic, full
 * access - which is deliberately neither the confidential launch client nor the Backend Services
 * client. Nothing in this module can be reached by the code under test.
 * @author John Grimes
 */

import type { LaunchEnvironment } from "./launch";
import type {
  Bundle,
  FhirResource,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
} from "fhir/r4";

/** The `Task.output` slot the direct send stamps the answers into (`contracts/shl-wire.md`). */
export const RESPONSE_OUTPUT_TEXT = "questionnaire-response";

/** RFC 3986 URI namespace: the system an invitation's business identifier lives under. */
export const URI_IDENTIFIER_SYSTEM = "urn:ietf:rfc:3986";

/** The code labelling a response as the patient's own assertion. */
export const PATIENT_ASSERTED_CODE = "PATAST";

/** The code system that code comes from. */
export const PATIENT_ASSERTED_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ObservationValue";

/**
 * Run a FHIR search on the launched server as the operator.
 * @param environment the resolved launch environment
 * @param resourceType the resource type to search, for example `QuestionnaireResponse`
 * @param query the search parameters
 * @returns the search-set Bundle
 * @throws {Error} when the server answers anything other than 2xx
 * @example
 * const found = await searchFhir(environment, "Provenance", { target: "QuestionnaireResponse/1" });
 */
export async function searchFhir(
  environment: LaunchEnvironment,
  resourceType: string,
  query: Record<string, string>,
): Promise<Bundle> {
  const url = new URL(`${environment.aidboxBaseUrl}/fhir/${resourceType}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  const credentials = Buffer.from(
    `${environment.operator.clientId}:${environment.operator.clientSecret}`,
    "utf8",
  ).toString("base64");
  const response = await fetch(url, {
    headers: {
      authorization: `Basic ${credentials}`,
      accept: "application/fhir+json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `searching ${resourceType} as the operator failed: HTTP ${response.status} ` +
        (await response.text()),
    );
  }
  /*
   * A 2xx from a FHIR search endpoint is a search-set Bundle by specification, and the only
   * consumer is `resourcesOf`, which checks each entry's `resourceType` before reading it. A
   * schema parse here would validate the server's conformance rather than the feature.
   */
  const bundle = (await response.json()) as Bundle;
  return bundle;
}

/**
 * The matched resources of a search-set Bundle, of one type.
 *
 * Aidbox reports `Bundle.total`, but a spec that trusts `total` and then reads `entry[0]` is
 * asserting two different things; taking the resources out once and counting them keeps the count
 * and the content in agreement. Included entries are dropped, so adding an `_include` to a query
 * can never inflate a count.
 * @param bundle the search-set Bundle
 * @param resourceType the resource type to keep
 * @returns the matching resources, in the order the server returned them
 * @example
 * const responses = resourcesOf<QuestionnaireResponse>(found, "QuestionnaireResponse");
 */
export function resourcesOf<T extends FhirResource>(
  bundle: Bundle,
  resourceType: T["resourceType"],
): T[] {
  return (bundle.entry ?? []).flatMap((entry) =>
    entry.resource?.resourceType === resourceType &&
    (entry.search?.mode ?? "match") === "match"
      ? [entry.resource as T]
      : [],
  );
}

/**
 * Search a resource type by an invitation's business identifier.
 *
 * The identifier system is applied here rather than at each call site: the response, the task and
 * the re-send check all have to search on exactly the token the send wrote
 * (`urn:ietf:rfc:3986|urn:uuid:…`), and a spec that got it subtly wrong would report zero matches
 * as a failure of the app.
 * @param environment the resolved launch environment
 * @param resourceType the resource type to search
 * @param requestIdentifier the invitation's `urn:uuid:` identifier
 * @returns the matching resources
 * @example
 * const tasks = await byRequestIdentifier<Task>(environment, "Task", requestIdentifier);
 */
export async function byRequestIdentifier<T extends FhirResource>(
  environment: LaunchEnvironment,
  resourceType: T["resourceType"],
  requestIdentifier: string,
): Promise<T[]> {
  const bundle = await searchFhir(environment, resourceType, {
    identifier: `${URI_IDENTIFIER_SYSTEM}|${requestIdentifier}`,
  });
  return resourcesOf<T>(bundle, resourceType);
}

/**
 * Flatten a stored response's nested items into `linkId` to answers.
 *
 * A `QuestionnaireResponse` mirrors the questionnaire's group nesting, so the answer to
 * `pi-lookssick` sits two levels down inside `pi-group`. Asserting through the nesting would make
 * every assertion depend on the fixture's group structure, which is not what any of them are
 * about; the pair of `linkId` and answers is.
 *
 * A `linkId` that appears more than once - which repeating groups produce - accumulates its
 * answers in document order rather than overwriting, so nothing is silently lost.
 * @param items the response's items, at any level
 * @returns a map from `linkId` to the answers recorded against it
 * @example
 * const answered = answersByLinkId(response.item ?? []);
 * expect(answered.get("patient-age")).toEqual([{ valueInteger: 52 }]);
 */
export function answersByLinkId(
  items: readonly QuestionnaireResponseItem[],
): Map<string, QuestionnaireResponseItemAnswer[]> {
  const flattened = new Map<string, QuestionnaireResponseItemAnswer[]>();
  const visit = (level: readonly QuestionnaireResponseItem[]): void => {
    for (const item of level) {
      if (item.answer !== undefined) {
        flattened.set(item.linkId, [
          ...(flattened.get(item.linkId) ?? []),
          ...item.answer,
        ]);
      }
      visit(item.item ?? []);
      for (const answer of item.answer ?? []) {
        visit(answer.item ?? []);
      }
    }
  };
  visit(items);
  return flattened;
}
