import { useQuery } from "@tanstack/react-query";
import { FileText, Search, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import Connect from "./Connect";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { searchQuestionnaires } from "@/fhir/formsServer";
import { FHIR_PROXY_BASE, useRequesterGate } from "@/lib/session";
import { useDebounced } from "@/lib/useDebounced";

/**
 * Forms held by the launched server.
 *
 * These used to come from a public forms catalogue. They now come from the clinical system the
 * requester signed in to, read through the BFF proxy (FR-004), so what is listed is what that
 * organisation actually publishes - and it is listed under the authority of the person signed in,
 * not anonymously.
 * @author John Grimes
 */
/**
 * The form list.
 * @returns the list, a launch prompt, or a loading line
 */
export default function FormList() {
  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebounced(searchText, 300);

  const {
    data: questionnaires,
    isPending,
    error,
  } = useQuery({
    queryKey: ["questionnaires", debouncedSearch],
    queryFn: ({ signal }) =>
      searchQuestionnaires(FHIR_PROXY_BASE, debouncedSearch, 100, signal),
  });

  const gate = useRequesterGate(error);

  if (gate.kind === "loading") {
    return <Loading>Checking your session…</Loading>;
  }
  if (gate.kind === "launch-required") {
    return <Connect reason={gate.reason} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Forms
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Questionnaires held by {gate.session.issuerLabel}
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
          placeholder="Search forms by title…"
          className="pl-9"
          aria-label="Search forms by title"
        />
      </div>

      {error ? (
        <Alert tone="error" title="Could not load forms">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      ) : null}

      {isPending ? <Loading>Loading forms…</Loading> : null}

      {questionnaires && questionnaires.length === 0 ? (
        <Alert title="No forms found">
          {debouncedSearch.trim() === ""
            ? `${gate.session.issuerLabel} holds no questionnaires this session can read. Forms without any items are hidden, since they cannot be rendered.`
            : `Nothing matched “${debouncedSearch}”. Forms without any items are hidden, since they cannot be rendered.`}
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(questionnaires ?? []).map((questionnaire) => (
          <li key={questionnaire.id}>
            <Card className="transition-colors hover:border-slate-400 dark:hover:border-slate-600">
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <FileText
                  className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                  aria-hidden
                />
                <Link
                  to={`/fill/${encodeURIComponent(questionnaire.id ?? "")}`}
                  className="min-w-0 flex-1"
                >
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {questionnaire.title ??
                      questionnaire.name ??
                      questionnaire.id}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                    {questionnaire.url ?? questionnaire.id}
                    {questionnaire.version ? ` | ${questionnaire.version}` : ""}
                  </p>
                </Link>
                <span className="shrink-0 self-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {questionnaire.status}
                </span>
                <Link
                  to={`/request/${encodeURIComponent(questionnaire.id ?? "")}`}
                  className="shrink-0 self-center"
                >
                  <Button variant="outline" size="sm">
                    <Send className="h-3.5 w-3.5" aria-hidden />
                    Request
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
