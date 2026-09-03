import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Search, User } from "lucide-react";
import { useState } from "react";

import type { Patient } from "fhir/r4";

import CreatePatientForm from "@/components/CreatePatientForm";
import { Input } from "@/components/ui/input";
import {
  describePatient,
  patientDisplay,
  searchPatients,
} from "@/fhir/ehrServer";
import { useDebounced } from "@/lib/useDebounced";
import { cn } from "@/lib/utils";

/**
 * Search a FHIR server for a patient, inline.
 *
 * The same question gets asked at both ends of the round trip (who is this form *for* when a request
 * goes out, and who are these answers *about* when they come back) and both were previously answered
 * by typing `Patient/123` into a text box from memory. This is that box, replaced with a search.
 *
 * Inline rather than a route, which matters more on the return leg than it looks: a scanned response
 * has been decrypted into memory and nothing on the server holds it yet, so navigating away to a
 * patient list would throw the answers away. See `src/routes/PatientList.tsx` for the browsable page,
 * which this deliberately does not replace.
 *
 * `serverUrl` is a parameter rather than read from config because the two callers mean different
 * servers by it: a request is addressed to a patient on the EHR, while a response has to name one the
 * destination* server can resolve, and a questionnaire may declare a destination of its own.
 * @author John Grimes
 */

export interface ChosenPatient {
  /** Relative, e.g. `Patient/123` - it only means anything against `serverUrl`. */
  reference: string;
  display: string;
  patient: Patient;
}

export interface PatientPickerProps {
  /** FHIR base URL to search. Also the server the returned reference is relative to. */
  serverUrl: string;
  onChoose: (chosen: ChosenPatient) => void;
  /** Reference already chosen, if any, so the matching row can be marked. */
  selectedReference?: string;
  /** Rows to fetch. Small by default: this is a picker, not a browser. */
  count?: number;
  placeholder?: string;
  /** Accessible name for the search box, when the surrounding copy does not already supply one. */
  label?: string;
  id?: string;
  /**
   * Offer to create a patient on `serverUrl` when the right one is not there.
   *
   * Gated on a search having happened, and that gate lives here rather than in the caller because
   * this component is the only thing that knows whether one has. "We looked, and there is no such
   * patient" is the only honest precondition for creating one.
   */
  allowCreate?: boolean;
  /**
   * Name to seed a new patient from - typically what the filler called them, since a free-text
   * `subject.display` is the only identifying thing any channel carries. Falls back to the search
   * text.
   */
  prefillName?: string;
}

/**
 *
 * @param props
 */
export default function PatientPicker(props: PatientPickerProps) {
  const {
    serverUrl,
    onChoose,
    selectedReference,
    count = 10,
    placeholder = "Search patients by name…",
    label = "Search patients by name",
    id,
    allowCreate = false,
    prefillName,
  } = props;

  const [searchText, setSearchText] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const debouncedSearch = useDebounced(searchText, 300);
  const searched = debouncedSearch.trim() !== "";

  function handleCreated(created: {
    reference: string;
    patient: Patient;
  }): void {
    setIsCreating(false);
    onChoose({
      reference: created.reference,
      display: patientDisplay(created.patient),
      patient: created.patient,
    });
  }

  /*
   * An empty search lists the server's patients rather than showing nothing, so the picker is useful
   * against a sandbox holding a handful of them without having to guess a name first.
   */
  const {
    data: page,
    isPending,
    isFetching,
    error,
  } = useQuery({
    queryKey: ["ehr-patients", serverUrl, debouncedSearch, count],
    queryFn: ({ signal }) =>
      searchPatients(serverUrl, debouncedSearch, count, signal),
  });

  const patients = page?.resources ?? [];
  const more = page?.total !== undefined && page.total > patients.length;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-slate-400"
          aria-hidden
        />
        <Input
          id={id}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder={placeholder}
          className="pl-9"
          aria-label={label}
        />
        {isFetching ? (
          <Loader2
            className="absolute top-3 right-3 h-4 w-4 animate-spin text-slate-400"
            aria-hidden
          />
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-red-700 dark:text-red-400">
          Could not search {serverUrl} -{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}

      {isPending ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">Searching…</p>
      ) : null}

      {!isPending && !error && patients.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {debouncedSearch.trim() === ""
            ? "This server holds no patients."
            : `Nothing matched “${debouncedSearch.trim()}”.`}
        </p>
      ) : null}

      {patients.length > 0 ? (
        <ul className="max-h-64 divide-y divide-slate-100 dark:divide-slate-800 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          {patients.map((patient) => {
            const reference = `Patient/${patient.id}`;
            const display = patientDisplay(patient);
            const summary = describePatient(patient);
            const isSelected = selectedReference === reference;

            return (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => onChoose({ reference, display, patient })}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-slate-400 dark:focus-visible:ring-slate-500 focus-visible:outline-none",
                    isSelected
                      ? "bg-slate-100 dark:bg-slate-800"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800",
                  )}
                >
                  {isSelected ? (
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
                      aria-hidden
                    />
                  ) : (
                    <User
                      className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                      {display}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {reference}
                      {summary ? ` · ${summary}` : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {more ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Showing {patients.length} of {page?.total} - narrow the search to see
          the rest.
        </p>
      ) : null}

      {/*
       * Offered alongside results rather than only in the empty state. Requiring no matches at all
       * would be too strict - searching a surname and getting three of the wrong people is the
       * common case - but searching first stays the path of least resistance.
       */}
      {allowCreate && !isCreating && patients.length > 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          None of these?{" "}
          <button
            type="button"
            onClick={() => {
              setIsCreating(true);
            }}
            className="underline underline-offset-2 hover:text-slate-900 dark:hover:text-slate-100"
          >
            Create a new patient
          </button>
          .
        </p>
      ) : null}

      {allowCreate && isCreating ? (
        <CreatePatientForm
          serverUrl={serverUrl}
          // What they just typed beats what arrived with the answers: it is the more recent
          // statement of who they are looking for. `prefillName` carries the rest of the way when
          // they have not typed anything.
          seedName={searched ? debouncedSearch.trim() : (prefillName ?? "")}
          onCreated={handleCreated}
          onCancel={() => {
            setIsCreating(false);
          }}
          onChooseExisting={(patient) => {
            setIsCreating(false);
            onChoose({
              reference: `Patient/${patient.id}`,
              display: patientDisplay(patient),
              patient,
            });
          }}
        />
      ) : null}
    </div>
  );
}
