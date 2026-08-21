import type { QuestionnaireResponse } from "fhir/r4";

import { flattenAnswers } from "@/lib/answerRows";

/**
 * The answer tree, flattened into a table, for when no Questionnaire can be resolved.
 *
 * Shared by the stored-response viewer and the review-before-accept flow, because both hit the same
 * situation: a response citing a canonical this deployment's forms server does not hold. See
 * `src/lib/answerRows.ts` for why that is the ordinary case rather than an edge one.
 * @author John Grimes
 */
export default function RawAnswers(props: { response: QuestionnaireResponse }) {
  const rows = flattenAnswers(props.response);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        This response records no answers.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <tr>
            <th className="px-3 py-2 font-medium">Question</th>
            <th className="px-3 py-2 font-medium">Answer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.linkId}-${index}`}
              className="border-t border-slate-100 dark:border-slate-800"
            >
              <td
                className="px-3 py-1.5"
                style={{ paddingLeft: `${0.75 + row.depth * 1}rem` }}
              >
                {row.text ?? (
                  <span className="font-mono text-slate-500 dark:text-slate-400">
                    {row.linkId}
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-slate-100">
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
