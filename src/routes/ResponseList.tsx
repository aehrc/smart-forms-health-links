import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";

import Connect from "./Connect";

import type { QuestionnaireResponse } from "fhir/r4";

import FormRenderer from "@/components/FormRenderer";
import RawAnswers from "@/components/RawAnswers";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loading } from "@/components/ui/loading";
import {
  fetchPatient,
  patientDisplay,
  searchQuestionnaireResponses,
} from "@/fhir/ehrServer";
import { fetchQuestionnaireByCanonical } from "@/fhir/formsServer";
import { useConfig } from "@/lib/configContextValue";
import { FHIR_PROXY_BASE, useRequesterGate } from "@/lib/session";

/**
 * QuestionnaireResponses already stored on the launched server.
 *
 * Distinct from `/requests`, which is about answers this app is still waiting for. This is what
 * is already there - including responses written by any other app pointed at the same server,
 * which is most of the value: it is how you confirm that a reply you accepted actually landed.
 *
 * Read-only throughout. Nothing here writes, and nothing here is a review step - the answers are
 * already in the record by the time they show up.
 * @author John Grimes
 */

/**
 * Whether a response carries the patient-asserted security label.
 * @param response the stored response
 * @returns true when it is labelled `PATAST`
 */
function isPatientAsserted(response: QuestionnaireResponse): boolean {
  return (response.meta?.security ?? []).some(
    (coding) => coding.code === "PATAST",
  );
}

/**
 * When a response was authored, or failing that when the server stored it.
 *
 * `authored` is optional and supplied by whichever app wrote the response, so it is missing often
 * enough to need the fallback - and the fallback has to say it is a different fact.
 * @param response the stored response
 * @returns the sentence fragment to append, or an empty string when neither date is known
 */
function responseWhen(response: QuestionnaireResponse): string {
  if (response.authored) {
    return ` · ${new Date(response.authored).toLocaleString()}`;
  }
  if (response.meta?.lastUpdated) {
    return ` · stored ${new Date(response.meta.lastUpdated).toLocaleString()}`;
  }
  return "";
}

/**
 * A short label for a response, from the form it answers.
 * @param response the stored response
 * @returns the last meaningful segment of the questionnaire canonical
 */
function responseTitle(response: QuestionnaireResponse): string {
  const canonical = response.questionnaire;
  if (!canonical) {
    return "Response to an unnamed form";
  }

  // The last meaningful path segment is a better label than the whole canonical, which is often long
  // and identical across many rows.
  const [url] = canonical.split("|");
  return url.split("/").findLast(Boolean) ?? canonical;
}

/**
 * The response list.
 * @returns the list, a launch prompt, or a loading line
 */
export default function ResponseList() {
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<QuestionnaireResponse | null>(null);

  const subject = params.get("subject") ?? undefined;

  const {
    data: page,
    isPending,
    error,
  } = useQuery({
    queryKey: ["responses", subject],
    queryFn: ({ signal }) =>
      searchQuestionnaireResponses(FHIR_PROXY_BASE, { subject }, signal),
  });

  // Only to name the filter chip; the list itself is already filtered server-side.
  const { data: filterPatient } = useQuery({
    queryKey: ["patient", subject],
    queryFn: ({ signal }) =>
      fetchPatient(FHIR_PROXY_BASE, subject!.split("/", 2)[1], signal),
    enabled: subject !== undefined && subject.startsWith("Patient/"),
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
      <BackLink />

      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Responses on the server
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Completed QuestionnaireResponses held by {gate.session.issuerLabel}
          {page?.total === undefined ? null : ` · ${page.total} in total`}
        </p>
      </div>

      {subject ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {filterPatient ? patientDisplay(filterPatient) : subject}
            <button
              type="button"
              onClick={() => {
                params.delete("subject");
                setParams(params, { replace: true });
              }}
              aria-label="Clear patient filter"
              className="rounded-full hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
          <RouterLink
            to="/patients"
            className="text-xs text-slate-600 underline dark:text-slate-400"
          >
            Change patient
          </RouterLink>
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          <RouterLink to="/patients" className="underline">
            Filter by patient
          </RouterLink>
        </p>
      )}

      {error ? (
        <Alert tone="error" title="Could not load responses">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      ) : null}

      {isPending ? <Loading>Loading responses…</Loading> : null}

      {page && page.resources.length === 0 ? (
        <Alert title="Nothing stored yet">
          {subject
            ? "This patient has no responses on this server."
            : `${gate.session.issuerLabel} holds no QuestionnaireResponses this session can read.`}
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(page?.resources ?? []).map((response) => (
          <li key={response.id}>
            <Card className="transition-colors hover:border-slate-400 dark:hover:border-slate-600">
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <ClipboardList
                  className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {responseTitle(response)}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                    {response.questionnaire ?? "no questionnaire canonical"}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    QuestionnaireResponse/{response.id}
                    {response.subject?.reference
                      ? ` · ${response.subject.reference}`
                      : null}
                    {responseWhen(response)}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2 self-center">
                  {isPatientAsserted(response) ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-900 dark:text-sky-100"
                      title="Recorded by the patient rather than a clinician"
                    >
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                      Patient
                    </span>
                  ) : null}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {response.status}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(response)}
                  >
                    View
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {selected ? (
        <ResponseViewer
          response={selected}
          issuerLabel={gate.session.issuerLabel}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Render a stored response against its Questionnaire.
 *
 * The Questionnaire has to be resolved separately, and sometimes there is nothing to resolve
 * from: `QuestionnaireResponse.questionnaire` is 0..1, so a response may carry no canonical at
 * all, which leaves no way to find a definition. A canonical naming a form this server does not
 * hold is the other case, and is expected on a server shared with apps that publish their
 * questionnaires elsewhere.
 *
 * Either way there is no form to render, so this falls back to showing the raw answers rather
 * than an error: the data is there and worth seeing, even unlabelled.
 * @param props the component props
 * @param props.response the response to render
 * @param props.issuerLabel the launched server's name, for the copy that explains a miss
 * @param props.onClose called when the viewer is dismissed
 * @returns the viewer
 */
function ResponseViewer(
  props: Readonly<{
    response: QuestionnaireResponse;
    issuerLabel: string;
    onClose: () => void;
  }>,
) {
  const { response, issuerLabel, onClose } = props;
  const config = useConfig();

  const canonical = response.questionnaire;

  const {
    data: questionnaire,
    isPending,
    error,
  } = useQuery({
    queryKey: ["questionnaire-by-canonical", canonical],
    queryFn: ({ signal }) =>
      fetchQuestionnaireByCanonical(FHIR_PROXY_BASE, canonical!, signal),
    enabled: canonical !== undefined,
    retry: false,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {responseTitle(response)}
            </CardTitle>
            <CardDescription>
              QuestionnaireResponse/{response.id} · read-only. Already stored on
              the server; there is nothing to accept here.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="ml-auto"
          >
            <X className="h-4 w-4" aria-hidden />
            Close
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isPatientAsserted(response) ? (
          <Alert title="Patient-asserted answers">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-slate-500" aria-hidden />
              Labelled <span className="font-mono text-xs">PATAST</span> -
              recorded by the person themselves rather than by a clinician.
            </span>
          </Alert>
        ) : null}

        {isPending && canonical ? (
          <Loading className="py-2">Resolving the form definition…</Loading>
        ) : null}

        {!canonical || error ? (
          <>
            <Alert
              tone="warning"
              title="The form definition could not be resolved"
            >
              {canonical ? (
                <>
                  This response cites{" "}
                  <span className="font-mono text-xs break-all">
                    {canonical}
                  </span>
                  , which {issuerLabel} does not hold. That is common on a
                  shared server - responses cite whatever canonical the app that
                  wrote them used. The answers are shown as stored instead.
                </>
              ) : (
                <>
                  This response has no{" "}
                  <span className="font-mono text-xs">questionnaire</span>{" "}
                  canonical, so there is no definition to render it against. The
                  answers are shown as stored instead.
                </>
              )}
            </Alert>
            <RawAnswers response={response} />
          </>
        ) : null}

        {questionnaire ? (
          <div className="form-surface">
            <FormRenderer
              questionnaire={questionnaire}
              questionnaireResponse={response}
              terminologyServerUrl={config.terminologyServerUrl}
              readOnly
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
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
