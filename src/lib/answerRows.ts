import type { QuestionnaireResponse } from "fhir/r4";

/**
 * Flatten a QuestionnaireResponse's answer tree into displayable rows.
 *
 * This is the last-resort reading of a response: what it says, without the Questionnaire that
 * defines how it should look. That case is ordinary rather than exceptional - a response cites
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

type Answer = NonNullable<
  NonNullable<QuestionnaireResponse["item"]>[number]["answer"]
>[number];

/**
 * Reduce one answer to a printable string.
 *
 * The value is found by the `value[x]` naming convention rather than by "whatever field is left
 * over". An answer is a `BackboneElement`, so it may also carry `id`, `extension`,
 * `modifierExtension` and `item` - and a leftover-field search picks whichever of those the sending
 * app happened to serialise first. That makes the rendered answer depend on a foreign app's JSON key
 * order, which fails intermittently rather than reproducibly.
 *
 * `valueCoding` is special-cased and read display-then-code: a coded answer rendered as
 * `[object Object]` is worse than useless to someone deciding whether to accept it into a record.
 * @param answer
 */
function answerValue(answer: Answer): string {
  if (answer.valueCoding) {
    return answer.valueCoding.display ?? answer.valueCoding.code ?? "";
  }

  const key = Object.keys(answer).find((candidate) =>
    candidate.startsWith("value"),
  );
  const value =
    key === undefined ? undefined : (answer as Record<string, unknown>)[key];

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

/**
 *
 * @param response
 */
export function flattenAnswers(response: QuestionnaireResponse): AnswerRow[] {
  const rows: AnswerRow[] = [];

  function walk(
    items: NonNullable<QuestionnaireResponse["item"]>,
    depth: number,
  ) {
    for (const item of items) {
      for (const answer of item.answer ?? []) {
        rows.push({
          linkId: item.linkId,
          text: item.text,
          value: answerValue(answer),
          depth,
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

/**
 * A single pre-filled answer, as a row a clinician can tick.
 *
 * Distinct from {@link AnswerRow}, which exists to *read* a response when its Questionnaire is
 * unavailable. This exists to *choose*, and choosing needs two things a display row does not: a key
 * stable enough to key a selection against, and enough context to tell two rows apart.
 */
export interface PopulatedRow {
  /** Selection key. Stable across renders, unique within a response — see {@link answerPaths}. */
  path: string;
  /** Group headings from the outside in, with repeat instances numbered. Empty at the top level. */
  groups: string[];
  linkId: string;
  /** The question, when the response carried it. All 12 answers on the GP plan do. */
  text?: string;
  value: string;
}

/**
 * Walk a response's answers, handing each one a path.
 *
 * The path is what makes per-field exclusion possible, and a `linkId` cannot be it. A repeating group
 * repeats its children's `linkId`s verbatim — two recorded problems produce two answers at
 * `…recordedproblems-condition` — so keying a selection on `linkId` would tick and untick both
 * entries together. Each segment therefore carries its occurrence among same-`linkId` siblings, and
 * each answer its index, giving `…recordedproblems~1/…-condition~0#0`.
 *
 * Shared by {@link populatedRows} and {@link pruneAnswers} rather than implemented twice, because the
 * two must agree exactly: a path the panel shows and the pruner does not recognise silently drops an
 * answer the clinician chose to keep.
 * @param response
 * @param visit
 */
function answerPaths(
  response: QuestionnaireResponse,
  visit: (row: Omit<PopulatedRow, "value"> & { answer: Answer }) => void,
): void {
  function walk(
    items: NonNullable<QuestionnaireResponse["item"]>,
    prefix: string,
    groups: string[],
  ) {
    const occurrences = new Map<string, number>();

    for (const item of items) {
      const occurrence = occurrences.get(item.linkId) ?? 0;
      occurrences.set(item.linkId, occurrence + 1);
      const path = `${prefix}${item.linkId}~${occurrence}`;

      for (const [index, answer] of (item.answer ?? []).entries()) {
        const hasValue = Object.keys(answer).some((key) =>
          key.startsWith("value"),
        );
        if (hasValue) {
          visit({
            path: `${path}#${index}`,
            groups,
            linkId: item.linkId,
            text: item.text,
            answer,
          });
        }

        if (answer.item) {
          walk(answer.item, `${path}#${index}/`, groups);
        }
      }

      if (item.item) {
        /*
         * A group heading is numbered only when it actually repeats. "Recorded problems 1" reads as a
         * distinction when there is nothing to distinguish it from.
         */
        const repeats =
          items.filter((sibling) => sibling.linkId === item.linkId).length > 1;
        const heading = item.text ?? item.linkId;
        walk(item.item, `${path}/`, [
          ...groups,
          repeats ? `${heading} ${occurrence + 1}` : heading,
        ]);
      }
    }
  }

  walk(response.item ?? [], "", []);
}

/**
 * Every pre-filled answer in a populated response, flattened into tickable rows.
 * @param response
 */
export function populatedRows(response: QuestionnaireResponse): PopulatedRow[] {
  const rows: PopulatedRow[] = [];

  answerPaths(response, ({ path, groups, linkId, text, answer }) => {
    rows.push({ path, groups, linkId, text, value: answerValue(answer) });
  });

  return rows;
}

/**
 * Drop every answer the clinician did not keep, and every item left holding nothing.
 *
 * Pruning empties as well as answers matters more than it looks. A `QuestionnaireResponse` item with
 * no answers and no children is not neutral — the renderer builds a form from it, and an item present
 * but empty reads to the filler as a question already visited and left blank rather than one nobody
 * has touched.
 *
 * Never mutates its input: `RequestForm` holds the populated response as query data, and a mutation
 * would prune it permanently the first time a box was unticked.
 * @param response
 * @param keep
 */
export function pruneAnswers(
  response: QuestionnaireResponse,
  keep: ReadonlySet<string>,
): QuestionnaireResponse {
  type Item = NonNullable<QuestionnaireResponse["item"]>[number];

  function walk(items: Item[], prefix: string): Item[] {
    const occurrences = new Map<string, number>();
    const kept: Item[] = [];

    for (const item of items) {
      const occurrence = occurrences.get(item.linkId) ?? 0;
      occurrences.set(item.linkId, occurrence + 1);
      const path = `${prefix}${item.linkId}~${occurrence}`;

      const answers = (item.answer ?? [])
        .map((answer, index) => ({ answer, index }))
        .filter(({ answer, index }) => {
          const hasValue = Object.keys(answer).some((key) =>
            key.startsWith("value"),
          );
          return hasValue
            ? keep.has(`${path}#${index}`)
            : answer.item !== undefined;
        })
        .map(({ answer, index }) => {
          if (!answer.item) {
            return answer;
          }

          const nested = walk(answer.item, `${path}#${index}/`);
          return nested.length > 0
            ? { ...answer, item: nested }
            : { ...answer, item: undefined };
        })
        .filter((answer) => {
          const hasValue = Object.keys(answer).some((key) =>
            key.startsWith("value"),
          );
          return hasValue || (answer.item?.length ?? 0) > 0;
        });

      const children = item.item ? walk(item.item, `${path}/`) : undefined;

      if (answers.length === 0 && (children?.length ?? 0) === 0) {
        continue;
      }

      kept.push({
        ...item,
        ...(answers.length > 0 ? { answer: answers } : { answer: undefined }),
        ...(children && children.length > 0
          ? { item: children }
          : { item: undefined }),
      });
    }

    return kept;
  }

  const items = walk(response.item ?? [], "");
  return {
    ...response,
    ...(items.length > 0 ? { item: items } : { item: undefined }),
  };
}
