import { Fragment } from 'react';
import type { OperationOutcome } from 'fhir/r4';
import type { PopulatedRow } from '@/lib/answerRows';
import { describeOutcome, outcomeHasErrors } from '@/fhir/templateExtract';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * What the record already says, as a list a clinician can tick before any of it leaves the building.
 *
 * The sibling of `WriteBackPanel`, and deliberately the same shape, because it asks the same question
 * at the other end of the round trip: that one is *what should these answers put into the record*,
 * this one is *what should the record put into these answers*. Everything is selected on arrival for
 * the same reason there — the values are what the record holds, so the default should be to honour
 * it, and removing what does not belong is a smaller question than assembling the set from nothing.
 *
 * Shown **before** the link is minted rather than reported after. Once a payload is encrypted and
 * uploaded nothing can be taken out of it, so this is the last point at which a wrong value is still
 * a decision rather than a disclosure.
 *
 * Rows are grouped by their heading path, which is what makes a repeating section readable: two
 * recorded problems otherwise arrive as six rows labelled Condition, Clinical status and Onset date,
 * with nothing to say which belongs to which.
 */

export interface PrePopulatePanelProps {
  rows: PopulatedRow[];
  /** What the engine could not do, when it still produced answers. */
  issues?: OperationOutcome | null;
  selected: ReadonlySet<string>;
  onSelectedChange: (selected: Set<string>) => void;
  /** Where the answers came from, named so the clinician can see it is the record they expect. */
  sourceLabel: string;
  /** Locked once the link is minted, because the choice has been acted on. */
  disabled?: boolean;
}

export default function PrePopulatePanel(props: PrePopulatePanelProps) {
  const { rows, issues, selected, onSelectedChange, sourceLabel, disabled = false } = props;

  function toggle(path: string) {
    const next = new Set(selected);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    onSelectedChange(next);
  }

  const kept = rows.filter((row) => selected.has(row.path)).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Filled in from the record</CardTitle>
            <CardDescription>
              Read from <span className="font-mono text-xs">{sourceLabel}</span>. Everything ticked
              travels inside the encrypted link, where the person filling the form can change or clear
              it. Untick anything they should answer themselves, or that the record has wrong.
            </CardDescription>
          </div>
          {!disabled && rows.length > 0 ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSelectedChange(new Set(rows.map((row) => row.path)))}
                disabled={selected.size === rows.length}>
                Select all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSelectedChange(new Set())}
                disabled={selected.size === 0}>
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {issues && !outcomeHasErrors(issues) ? (
          <Alert tone="warning" title="Population reported something worth reading">
            <p>{describeOutcome(issues)}</p>
            <p className="mt-1">
              Some of this may be less complete than it looks. A part of the record the server would
              not return is indistinguishable here from a part that is empty.
            </p>
          </Alert>
        ) : null}

        {rows.length === 0 ? (
          <Alert title="The record filled in nothing">
            <p>
              This form declares pre-population and the reads succeeded, so this is most likely what
              the record holds for this patient rather than a failure. The form can still be sent; it
              will go out blank.
            </p>
          </Alert>
        ) : (
          <>
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {rows.map((row, index) => {
                const heading = row.groups.join(' › ');
                const newGroup = index === 0 || heading !== rows[index - 1].groups.join(' › ');
                const inputId = `pre-populate-${row.path}`;

                return (
                  <Fragment key={row.path}>
                    {newGroup && heading !== '' ? (
                      <li className="bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                        {heading}
                      </li>
                    ) : null}
                    <li className="flex items-start gap-3 p-3">
                      <input
                        id={inputId}
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(row.path)}
                        disabled={disabled}
                        onChange={() => toggle(row.path)}
                      />
                      <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                        <span className="block font-medium text-slate-900">
                          {row.text ?? row.linkId}
                        </span>
                        <span className="mt-0.5 block break-words text-xs text-slate-600">
                          {row.value}
                        </span>
                      </label>
                    </li>
                  </Fragment>
                );
              })}
            </ul>

            <p className="text-xs text-slate-500">
              {kept} of {rows.length} answers will be sent.
              {kept === 0
                ? ' With none ticked the form goes out blank, exactly as it would without pre-filling.'
                : ''}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
