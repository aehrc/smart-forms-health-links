import type { QuestionnaireResponse } from 'fhir/r4';

/**
 * Flatten a QuestionnaireResponse's answer tree into displayable rows.
 *
 * This is the last-resort reading of a response: what it says, without the Questionnaire that
 * defines how it should look. That case is ordinary rather than exceptional — a response cites
 * whatever canonical the app that wrote it used, and on a shared server that is frequently a form
 * this deployment's catalogue does not hold. Answers are the clinical content; the definition is
 * presentation, so losing the latter must not cost the former.
 *
 * Pure and free of React so `check:roundtrip` can assert the walk offline.
 */

export interface AnswerRow {
  linkId: string;
  /** The question text, when the response carried it. Falls back to `linkId` for display. */
  text?: string;
  /** The answer, already reduced to something printable. */
  value: string;
  /** Nesting depth, for indentation. */
  depth: number;
}

type Answer = NonNullable<NonNullable<QuestionnaireResponse['item']>[number]['answer']>[number];

/**
 * Reduce one answer to a printable string.
 *
 * The value is found by the `value[x]` naming convention rather than by "whatever field is left
 * over". An answer is a `BackboneElement`, so it may also carry `id`, `extension`,
 * `modifierExtension` and `item` — and a leftover-field search picks whichever of those the sending
 * app happened to serialise first. That makes the rendered answer depend on a foreign app's JSON key
 * order, which fails intermittently rather than reproducibly.
 *
 * `valueCoding` is special-cased and read display-then-code: a coded answer rendered as
 * `[object Object]` is worse than useless to someone deciding whether to accept it into a record.
 */
function answerValue(answer: Answer): string {
  if (answer.valueCoding) {
    return answer.valueCoding.display ?? answer.valueCoding.code ?? '';
  }

  const key = Object.keys(answer).find((candidate) => candidate.startsWith('value'));
  const value = key === undefined ? undefined : (answer as Record<string, unknown>)[key];

  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
}

export function flattenAnswers(response: QuestionnaireResponse): AnswerRow[] {
  const rows: AnswerRow[] = [];

  function walk(items: NonNullable<QuestionnaireResponse['item']>, depth: number) {
    for (const item of items) {
      for (const answer of item.answer ?? []) {
        rows.push({
          linkId: item.linkId,
          text: item.text,
          value: answerValue(answer),
          depth
        });

        if (answer.item) {
          walk(answer.item, depth + 1);
        }
      }

      if (item.item) {
        walk(item.item, depth + 1);
      }
    }
  }

  walk(response.item ?? [], 0);
  return rows;
}
