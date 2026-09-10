import { CheckCircle2, FilePlus2, Loader2, PencilLine } from "lucide-react";

import type { BundleWriteResult } from "@/fhir/writeBundle";
import type { EntryRow } from "@/lib/extractedEntries";
import type { OperationOutcome } from "fhir/r4";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  describeOutcome,
  outcomeHasErrors,
  type ExtractMechanism,
} from "@/fhir/extract";

/**
 * What these answers would put in the patient's record, as a list a clinician can tick.
 *
 * Shown **before** the accept, not in a dialog afterwards. smart-forms extracts when you press save and
 * then asks; here the whole app is built around a human seeing what is about to happen while they can
 * still change it, so the list sits next to the button rather than in front of it.
 *
 * Everything is selected on arrival. The extraction is the form author's statement about what these
 * answers mean, so the default should be to honour it; the reviewer's job is to *remove* what does not
 * belong, which is a smaller and more answerable question than building the set from nothing.
 */

export interface WriteBackPanelProps {
  mechanism: Exclude<ExtractMechanism, null>;
  rows: EntryRow[];
  /** Warnings the engine raised while still producing a bundle. */
  issues?: OperationOutcome | null;
  selected: ReadonlySet<number>;
  onSelectedChange: (selected: Set<number>) => void;
  /** Locked once the response has been written, because the choice has been acted on. */
  disabled?: boolean;
  /** Results of the write, when it has happened. */
  results?: BundleWriteResult[] | null;
  isSaving?: boolean;
}

const MECHANISM_LABEL: Record<Exclude<ExtractMechanism, null>, string> = {
  "template-based": "template-based extraction",
  "observation-based": "observation-based extraction",
};

function MethodChip({ method }: { method: EntryRow["method"] }) {
  return method === "new" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">
      <FilePlus2 className="h-3 w-3" aria-hidden />
      new
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
      <PencilLine className="h-3 w-3" aria-hidden />
      update
    </span>
  );
}

/**
 *
 * @param props
 */
export default function WriteBackPanel(props: WriteBackPanelProps) {
  const {
    mechanism,
    rows,
    issues,
    selected,
    onSelectedChange,
    disabled = false,
    results = null,
    isSaving = false,
  } = props;

  function toggle(index: number) {
    const next = new Set(selected);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    onSelectedChange(next);
  }

  const written =
    results?.flatMap((result) =>
      result.entries.filter((entry) => !entry.error),
    ) ?? [];
  const failures =
    results?.filter(
      (result) => result.error || result.entries.some((e) => e.error),
    ) ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              Write these into the patient record
            </CardTitle>
            <CardDescription>
              This form declares {MECHANISM_LABEL[mechanism]}, so its answers
              can become resources on the record rather than only a stored form.
              Nothing here is written until you accept, and only what is ticked
              is written at all.
            </CardDescription>
          </div>
          {!disabled && rows.length > 0 ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onSelectedChange(new Set(rows.map((row) => row.index)))
                }
                disabled={selected.size === rows.length}
              >
                Select all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSelectedChange(new Set())}
                disabled={selected.size === 0}
              >
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {issues && !outcomeHasErrors(issues) ? (
          <Alert
            tone="warning"
            title="Extraction reported something worth reading"
          >
            <p>{describeOutcome(issues)}</p>
            <p className="mt-1">
              A resource below may be less complete than it looks, so it is
              worth checking the values before ticking it.
            </p>
          </Alert>
        ) : null}

        {rows.length === 0 ? (
          <Alert title="Nothing to write back">
            This form supports {MECHANISM_LABEL[mechanism]}, but these
            particular answers produced no resources. That usually means the
            questions its templates draw on were left blank.
          </Alert>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
            {rows.map((row) => {
              const isChecked = selected.has(row.index);
              const inputId = `write-back-entry-${row.index}`;

              return (
                <li key={row.index} className="flex items-start gap-3 p-3">
                  <input
                    id={inputId}
                    type="checkbox"
                    className="mt-1"
                    checked={isChecked}
                    disabled={disabled}
                    onChange={() => toggle(row.index)}
                  />
                  <label
                    htmlFor={inputId}
                    className="min-w-0 flex-1 cursor-pointer"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {row.display}
                      </span>
                      <MethodChip method={row.method} />
                    </span>
                    <span className="mt-0.5 block font-mono text-xs text-slate-500">
                      {row.resourceType}
                      {row.target ? ` → ${row.target}` : null}
                    </span>
                    {row.patchOperationCount === undefined ? null : (
                      /*
                       * Said plainly rather than expanded into a sub-list. The operations are JSON
                       * Patch against a resource this screen cannot show, so offering them
                       * individually would ask for a judgement nobody can make from here.
                       */
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {row.patchOperationCount}{" "}
                        {row.patchOperationCount === 1 ? "change" : "changes"}{" "}
                        to an existing record — written together or not at all.
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {rows.length > 0 && !disabled ? (
          <p className="text-xs text-slate-500">
            {selected.size} of {rows.length} selected. They are written as a
            single FHIR transaction, so either all of them land or none of them
            do.
          </p>
        ) : null}

        {written.length > 0 ? (
          <Alert title="Written to the record">
            <ul className="space-y-0.5">
              {written.map((entry) => (
                <li
                  key={`${entry.index}-${entry.location}`}
                  className="flex items-center gap-1.5"
                >
                  <CheckCircle2
                    className="h-3.5 w-3.5 text-green-600"
                    aria-hidden
                  />
                  <span className="font-mono text-xs">
                    {entry.location ?? entry.status}
                  </span>
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {failures.length > 0 ? (
          <Alert
            tone="error"
            title="The answers were saved, but the write-back was not"
          >
            <ul className="space-y-0.5">
              {failures.map((result) => (
                <li key={result.serverUrl} className="text-xs">
                  <span className="font-mono">{result.serverUrl}</span> —{" "}
                  {result.error ??
                    result.entries
                      .filter((entry) => entry.error)
                      .map((entry) => entry.error)
                      .join("; ")}
                </li>
              ))}
            </ul>
            <p className="mt-1">
              A transaction is all-or-nothing, so nothing from this list reached
              the record. The response itself is stored and unaffected.
            </p>
          </Alert>
        ) : null}

        {isSaving ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Writing to the record…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
