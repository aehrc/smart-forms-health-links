import type { Bundle, OperationOutcome, Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import { canBeTemplateExtracted, extractResultIsOperationOutcome, inAppExtract } from '@aehrc/sdc-template-extract';

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

/** Whether this form declares template-based extraction. */
export function canTemplateExtract(questionnaire: Questionnaire | undefined): boolean {
  return questionnaire !== undefined && canBeTemplateExtracted(questionnaire);
}

/**
 * Run template-based extraction, or throw with something a reviewer can act on.
 *
 * **`comparisonSourceResponse` is deliberately `null`.** smart-forms passes a freshly populated copy of
 * the questionnaire here so that only answers the clinician *changed* get extracted. That baseline
 * cannot exist in this app: the person who filled the form had no access to the EHR and no launch
 * context, which is the whole point of the design. There is nothing to diff against, so everything the
 * template produces is new by definition — and passing `null` is exactly how the engine expresses that.
 * It is also why `@aehrc/sdc-populate` is not a dependency here.
 */
export async function templateExtract(
  response: QuestionnaireResponse,
  questionnaire: Questionnaire
): Promise<{ bundle: Bundle; issues: OperationOutcome | null }> {
  const { extractResult } = await inAppExtract(structuredClone(response), questionnaire, null);

  if (extractResultIsOperationOutcome(extractResult)) {
    throw new Error(describeOutcome(extractResult) ?? 'Extraction failed.');
  }

  return { bundle: extractResult.extractedBundle, issues: extractResult.issues };
}

/** The human-readable half of an OperationOutcome, when it has one. */
export function describeOutcome(outcome: OperationOutcome): string | null {
  const text = (outcome.issue ?? [])
    .map((issue) => issue.diagnostics ?? issue.details?.text)
    .filter((value): value is string => !!value);

  return text.length > 0 ? text.join('; ') : null;
}

/** Whether an OperationOutcome carries anything worse than a warning. */
export function outcomeHasErrors(outcome: OperationOutcome): boolean {
  return (outcome.issue ?? []).some(
    (issue) => issue.severity === 'error' || issue.severity === 'fatal'
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
 * *original* subject, and never invents one where the resource had none: a resource whose subject the
 * template left empty is a template bug, and quietly filling it in would hide that behind a plausible
 * answer.
 */
export function retargetSubject(
  bundle: Bundle,
  reconciled: QuestionnaireResponse,
  originalSubject?: string
): Bundle {
  const replacement = reconciled.subject?.reference;

  if (!originalSubject || !replacement || originalSubject === replacement) {
    return bundle;
  }

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(rewrite);
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
        const isSubjectSlot = key === 'subject' || key === 'patient';
        const reference =
          isSubjectSlot && nested !== null && typeof nested === 'object'
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
              : { reference: replacement }
          ];
        }

        return [key, rewrite(nested)];
      })
    );
  };

  return rewrite(bundle) as Bundle;
}
