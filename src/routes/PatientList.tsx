import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Search, Send, User } from "lucide-react";
import { useState } from "react";
import {
  Link as RouterLink,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import Connect from "./Connect";

import type { Patient } from "fhir/r4";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import {
  describePatient,
  patientDisplay,
  searchPatients,
} from "@/fhir/ehrServer";
import { FHIR_PROXY_BASE, useRequesterGate } from "@/lib/session";
import { useDebounced } from "@/lib/useDebounced";

/**
 * Patients on the launched server.
 *
 * Two jobs, both about not typing references by hand. It picks the subject of a request -
 * `Task.for` wants a reference the requester's server can resolve *and* a display name, since a
 * filler cannot resolve a reference into a server it has no access to. And it filters the
 * response list.
 *
 * `returnTo` carries the caller through, so choosing a patient goes back where you came from
 * rather than dead-ending here.
 * @author John Grimes
 */

/** Rows per page here. Larger than the inline picker's, because this page is for browsing. */
const PAGE_SIZE = 50;

/**
 * The patient list.
 * @returns the list, a launch prompt, or a loading line
 */
export default function PatientList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebounced(searchText, 300);

  /*
   * Where to go once a patient is chosen. Restricted to an in-app path: this value comes from the
   * URL, so treating it as a destination without checking would let a crafted link bounce someone
   * off-site.
   */
  const rawReturnTo = params.get("returnTo");
  const returnTo =
    rawReturnTo?.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : null;

  const {
    data: page,
    isPending,
    error,
  } = useQuery({
    queryKey: ["patients", debouncedSearch, PAGE_SIZE],
    queryFn: ({ signal }) =>
      searchPatients(FHIR_PROXY_BASE, debouncedSearch, PAGE_SIZE, signal),
  });

  const gate = useRequesterGate(error);

  function choose(patient: Patient) {
    const reference = `Patient/${patient.id}`;
    const display = patientDisplay(patient);

    if (returnTo) {
      const separator = returnTo.includes("?") ? "&" : "?";
      void navigate(
        `${returnTo}${separator}subject=${encodeURIComponent(reference)}&subjectDisplay=${encodeURIComponent(display)}`,
      );
      return;
    }

    void navigate(`/responses?subject=${encodeURIComponent(reference)}`);
  }

  if (gate.kind === "loading") {
    return <Loading>Checking your session…</Loading>;
  }
  if (gate.kind === "launch-required") {
    return <Connect reason={gate.reason} />;
  }

  return (
    <div className="space-y-4">
      <BackLink />

      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Patients
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          On {gate.session.issuerLabel}
          {page?.total === undefined ? null : ` · ${page.total} in total`}
          {returnTo ? " · choose who the request is for" : null}
        </p>
      </div>

      <div className="relative">
        <Search
          className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-slate-400"
          aria-hidden
        />
        <Input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Search patients by name…"
          className="pl-9"
          aria-label="Search patients by name"
        />
      </div>

      {error ? (
        <Alert tone="error" title="Could not load patients">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      ) : null}

      {isPending ? <Loading>Loading patients…</Loading> : null}

      {page && page.resources.length === 0 ? (
        <Alert title="No patients found">
          {debouncedSearch.trim() === ""
            ? `${gate.session.issuerLabel} holds no patients this session can read.`
            : `Nothing matched “${debouncedSearch}”.`}
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(page?.resources ?? []).map((patient) => (
          <li key={patient.id}>
            <Card className="transition-colors hover:border-slate-400 dark:hover:border-slate-600">
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <User
                  className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {patientDisplay(patient)}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    Patient/{patient.id}
                    {describePatient(patient)
                      ? ` · ${describePatient(patient)}`
                      : null}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">
                  {returnTo ? (
                    <Button size="sm" onClick={() => choose(patient)}>
                      <Send className="h-3.5 w-3.5" aria-hidden />
                      Use as subject
                    </Button>
                  ) : null}
                  <RouterLink
                    to={`/responses?subject=${encodeURIComponent(`Patient/${patient.id}`)}`}
                  >
                    <Button variant="outline" size="sm">
                      <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                      Responses
                    </Button>
                  </RouterLink>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The link back to the form list, repeated on every sub-surface.
 * @returns the link
 */
function BackLink() {
  return (
    <RouterLink
      to="/"
      className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All forms
    </RouterLink>
  );
}
