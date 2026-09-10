import {
  canBeTemplateExtracted,
  extractResultIsOperationOutcome,
  inAppExtract,
} from "@aehrc/sdc-template-extract";

import type {
  Bundle,
  OperationOutcome,
  Questionnaire,
  QuestionnaireResponse,
} from "fhir/r4";

/**
 * Template-based extraction, and the parts of extraction that depend on nothing else.
 *
 * Split from `src/fhir/extract.ts` for the same reason `src/auth/scopes.ts` is split from
 * `smartSession.ts`: its sibling imports `@aehrc/smart-forms-renderer` for the observation mechanism,
 * and that package is a browser bundle carrying CSS and font files. In a browser that costs nothing;
 * in the Node check harness esbuild has no loader for a `.woff2` and the bundle fails outright.
 *
 * So the half that can be asserted offline lives here, where `check:roundtrip` can reach it, and the
 * half that genuinely needs the renderer stays next door. `@aehrc/sdc-template-extract` is pure
 * TypeScript over `fhirpath` and bundles for Node without complaint.
 */

/**
 * Whether this form declares template-based extraction.
 * @param questionnaire
 */
export function canTemplateExtract(
  questionnaire: Questionnaire | undefined,
): boolean {
  return questionnaire !== undefined && canBeTemplateExtracted(questionnaire);
}

/**
 * Run template-based extraction, or throw with something a reviewer can act on.
 *
 * **`comparisonSourceResponse` is deliberately `null`**, and it is worth saying why it stays `null`
 * now that it need not.
 *
 * smart-forms passes a freshly populated copy of the questionnaire here so that only answers the
 * clinician *changed* get extracted. This file used to record that such a baseline could not exist
 * here, because the person filling the form had no access to the EHR — and that reason expired when
 * requests gained the option to be pre-filled (`src/fhir/populate.ts`). A populated baseline now
 * exists, and `@aehrc/sdc-populate` is now a dependency.
 *
 * The `null` survives the reason for it, on three grounds:
 *
 *  - **The baseline is the requester's; the answers are a stranger's.** smart-forms diffs a response
 *    against a copy of itself. Here the two come from different devices, and are comparable only if
 *    the filler preserved the `linkId` structure — which a conformant filler will and nothing
 *    obliges one to.
 *  - **A pre-filled request is the minority case**, and a request sent blank still has no baseline.
 *    Diffing would give the app two extraction modes producing different resources from identical
 *    answers, and the reviewer would have to be told which one ran.
 *  - **`retargetSubject` below exists because extraction here runs on foreign answers.** A diff-based
 *    extract interacts with that, and neither has been worked through against the other.
 *
 * So everything the template produces is still treated as new, which is what `null` expresses.
 * Extracting only what the patient actually changed is worth doing and is not done here yet.
 * @param response
 * @param questionnaire
 */
export async function templateExtract(
  response: QuestionnaireResponse,
  questionnaire: Questionnaire,
): Promise<{ bundle: Bundle; issues: OperationOutcome | null }> {
  const { extractResult } = await inAppExtract(
    structuredClone(response),
    questionnaire,
    null,
  );

  if (extractResultIsOperationOutcome(extractResult)) {
    throw new Error(describeOutcome(extractResult) ?? "Extraction failed.");
  }

  return {
    bundle: extractResult.extractedBundle,
    issues: extractResult.issues,
  };
}

/**
 * The human-readable half of an OperationOutcome, when it has one.
 * @param outcome
 */
export function describeOutcome(outcome: OperationOutcome): string | null {
  const text = (outcome.issue ?? [])
    .map((issue) => issue.diagnostics ?? issue.details?.text)
    .filter((value): value is string => !!value);

  return text.length > 0 ? text.join("; ") : null;
}

/**
 * Whether an OperationOutcome carries anything worse than a warning.
 * @param outcome
 */
export function outcomeHasErrors(outcome: OperationOutcome): boolean {
  return (outcome.issue ?? []).some(
    (issue) => issue.severity === "error" || issue.severity === "fatal",
  );
}

/**
 * Repoint any extracted resource still filed against the subject the answers *arrived* with.
 *
 * A safety net, and one with no counterpart in smart-forms, because smart-forms extracts from a
 * response it populated itself and this app extracts from one a stranger's phone sent.
 *
 * A well-written template reads the subject through `%resource.subject`, so extracting from the
 * reconciled response is already enough and this pass finds nothing to do. A template that instead
 * hardcodes a reference, or copies one out of an answer, would otherwise file a Condition against the
 * filler's own local patient key — a reference the destination server does not hold, which is exactly
 * the failure the reviewer just spent a reconciliation step fixing.
 *
 * Deliberately narrow. It rewrites `subject` and `patient` only, only where the value still equals the
 * original* subject, and never invents one where the resource had none: a resource whose subject the
 * template left empty is a template bug, and quietly filling it in would hide that behind a plausible
 * answer.
 * @param bundle
 * @param reconciled
 * @param originalSubject
 */
export function retargetSubject(
  bundle: Bundle,
  reconciled: QuestionnaireResponse,
  originalSubject?: string,
): Bundle {
  const replacement = reconciled.subject?.reference;

  if (!originalSubject || !replacement || originalSubject === replacement) {
    return bundle;
  }

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => rewrite(entry));
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
        const isSubjectSlot = key === "subject" || key === "patient";
        const reference =
          isSubjectSlot && nested !== null && typeof nested === "object"
            ? (nested as { reference?: unknown }).reference
            : undefined;

        if (reference === originalSubject) {
          return [
            key,
            // The display goes with the reference. Carrying the filler's name across onto a patient the
            // reviewer chose would label the resource with a name nobody on the destination picked —
            // the same call `reconciledResponse` already makes in `ReviewResponse`.
            reconciled.subject?.display
              ? { reference: replacement, display: reconciled.subject.display }
              : { reference: replacement },
          ];
        }

        return [key, rewrite(nested)];
      }),
    );
  };

  return rewrite(bundle) as Bundle;
}
