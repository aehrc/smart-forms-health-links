import { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ClipboardList, Loader2, ShieldCheck, UserRound, X } from 'lucide-react';
import type { QuestionnaireResponse } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import { useEhrServerUrl, useSmartSession } from '@/auth/SmartContext';
import {
  fetchPatient,
  fetchUserDisplay,
  patientDisplay,
  searchQuestionnaireResponses
} from '@/fhir/ehrServer';
import { fetchQuestionnaireByCanonical } from '@/fhir/formsServer';
import FormRenderer from '@/components/FormRenderer';
import RawAnswers from '@/components/RawAnswers';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * QuestionnaireResponses already stored on the EHR.
 *
 * Distinct from `/requests`, which is about answers this app is still waiting for. This is what is
 * already there — including responses written by smart-forms or anything else pointed at the same
 * server, which is most of the value: it is how you confirm that a reply you accepted actually landed.
 *
 * Read-only throughout. Nothing here writes, and nothing here is a review step — the answers are
 * already in the record by the time they show up.
 */

/** Whether a response carries the patient-asserted security label. */
function isPatientAsserted(response: QuestionnaireResponse): boolean {
  return (response.meta?.security ?? []).some((coding) => coding.code === 'PATAST');
}

function responseTitle(response: QuestionnaireResponse): string {
  const canonical = response.questionnaire;
  if (!canonical) {
    return 'Response to an unnamed form';
  }

  // The last meaningful path segment is a better label than the whole canonical, which is often long
  // and identical across many rows.
  const [url] = canonical.split('|');
  return url.split('/').filter(Boolean).pop() ?? canonical;
}

/**
 * Who recorded a response, as a name if one can be had and a reference otherwise.
 *
 * Worth surfacing in the list rather than only on the detail view, because it is what distinguishes a
 * patient's own answers from a clinician's revision of them at a glance. An amendment writes the
 * amending user here — see `src/fhir/amend.ts` — so after a launch this is a `Practitioner` the
 * authorisation server vouched for rather than a name somebody typed.
 *
 * Returns null when the server holds no author at all, which callers should render as an explicit
 * absence: an accepted response that nobody is recorded as having authored is a real gap, not a
 * cosmetic one, and hiding it would make the record look more complete than it is.
 */
function authorLabel(
  response: QuestionnaireResponse,
  names: Map<string, string>
): { text: string; resolved: boolean } | null {
  const author = response.author;
  if (!author) {
    return null;
  }

  if (author.display) {
    return { text: author.display, resolved: true };
  }

  const reference = author.reference;
  if (!reference) {
    return null;
  }

  const name = names.get(reference);
  return name ? { text: name, resolved: true } : { text: reference, resolved: false };
}

export default function ResponseList() {
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<QuestionnaireResponse | null>(null);

  const subject = params.get('subject') ?? undefined;
  const ehrServerUrl = useEhrServerUrl();
  const session = useSmartSession();

  const {
    data: page,
    isPending,
    error
  } = useQuery({
    // `fhirUser` in the key so signing in or out refetches — see PatientList.
    queryKey: ['ehr-responses', ehrServerUrl, session?.fhirUser ?? null, subject],
    queryFn: ({ signal }) =>
      searchQuestionnaireResponses(ehrServerUrl!, { subject, session }, signal),
    enabled: ehrServerUrl !== null
  });

  /*
   * Names for authors the server named only by reference.
   *
   * Deduplicated, because a list of fifty responses is usually the work of a handful of people and
   * fetching `Practitioner/123` once per row would be forty-odd redundant reads. Resolved in one query
   * keyed on the distinct set, so it refetches when the page changes and not otherwise.
   *
   * `fetchUserDisplay` fails soft per reference, so a Practitioner this user cannot read costs that one
   * name and not the list.
   */
  const authorRefs = [
    ...new Set(
      (page?.resources ?? [])
        .map((response) => (response.author?.display ? undefined : response.author?.reference))
        .filter((reference): reference is string => reference !== undefined)
    )
  ].sort();

  const { data: authorNames } = useQuery({
    queryKey: ['response-authors', ehrServerUrl, session?.fhirUser ?? null, authorRefs.join('|')],
    queryFn: async ({ signal }) => {
      const resolved = await Promise.all(
        authorRefs.map(async (reference) => [
          reference,
          await fetchUserDisplay(ehrServerUrl!, reference, signal, session)
        ] as const)
      );

      return new Map(
        resolved.filter((pair): pair is [string, string] => pair[1] !== null)
      );
    },
    enabled: ehrServerUrl !== null && authorRefs.length > 0
  });

  // Only to name the filter chip; the list itself is already filtered server-side.
  const { data: filterPatient } = useQuery({
    queryKey: ['ehr-patient', ehrServerUrl, session?.fhirUser ?? null, subject],
    queryFn: ({ signal }) => fetchPatient(ehrServerUrl!, subject!.split('/')[1], signal, session),
    enabled: ehrServerUrl !== null && subject !== undefined && subject.startsWith('Patient/')
  });

  if (!ehrServerUrl) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert tone="warning" title="No EHR server is configured">
          Set <span className="font-mono text-xs">responseServerUrl</span> in{' '}
          <span className="font-mono text-xs">config.json</span>. That is the server holding patients and
          their responses — deliberately not the forms server, which is a read-only catalogue of
          questionnaire definitions.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />

      <div>
        <h1 className="text-xl font-semibold text-slate-900">Responses on the server</h1>
        <p className="text-sm text-slate-500">
          Completed QuestionnaireResponses held by{' '}
          <span className="font-mono text-xs">{ehrServerUrl}</span>
          {page?.total !== undefined ? ` · ${page.total} in total` : null}
        </p>
      </div>

      {subject ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
            {filterPatient ? patientDisplay(filterPatient) : subject}
            <button
              type="button"
              onClick={() => {
                params.delete('subject');
                setParams(params, { replace: true });
              }}
              aria-label="Clear patient filter"
              className="rounded-full hover:bg-slate-200">
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
          <RouterLink to="/patients" className="text-xs text-slate-600 underline">
            Change patient
          </RouterLink>
        </div>
      ) : (
        <p className="text-sm text-slate-500">
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

      {isPending ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading responses…
        </p>
      ) : null}

      {page && page.resources.length === 0 ? (
        <Alert title="Nothing stored yet">
          {subject
            ? 'This patient has no responses on this server.'
            : 'This server holds no QuestionnaireResponses.'}
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(page?.resources ?? []).map((response) => (
          <li key={response.id}>
            <Card className="transition-colors hover:border-slate-400">
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">{responseTitle(response)}</p>
                  <p className="truncate font-mono text-xs text-slate-500">
                    {response.questionnaire ?? 'no questionnaire canonical'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    QuestionnaireResponse/{response.id}
                    {response.subject?.reference ? ` · ${response.subject.reference}` : null}
                    {response.authored
                      ? ` · ${new Date(response.authored).toLocaleString()}`
                      : response.meta?.lastUpdated
                        ? ` · stored ${new Date(response.meta.lastUpdated).toLocaleString()}`
                        : null}
                  </p>
                  {(() => {
                    const author = authorLabel(response, authorNames ?? new Map());
                    return (
                      <p className="mt-0.5 flex items-center gap-1 text-xs">
                        <UserRound className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
                        {author ? (
                          <span className={author.resolved ? 'text-slate-600' : 'font-mono text-slate-500'}>
                            Recorded by {author.text}
                          </span>
                        ) : (
                          /* Stated rather than omitted: an accepted response records who answered but
                             nobody as having recorded it, and that absence is worth seeing. */
                          <span className="text-slate-400 italic">No author recorded</span>
                        )}
                      </p>
                    );
                  })()}
                </div>

                <div className="flex shrink-0 items-center gap-2 self-center">
                  {isPatientAsserted(response) ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900"
                      title="Recorded by the patient rather than a clinician">
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                      Patient
                    </span>
                  ) : null}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {response.status}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setSelected(response)}>
                    View
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {selected ? <ResponseViewer response={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

/**
 * Render a stored response against its Questionnaire.
 *
 * The Questionnaire has to be resolved separately, and sometimes there is nothing to resolve *from*: 4 of
 * the 23 responses on the CSIRO proxy carry no `questionnaire` canonical at all, which is legal FHIR
 * (`QuestionnaireResponse.questionnaire` is 0..1) and leaves no way to find a definition. A canonical
 * that names a form this forms server does not hold is the other case, and is expected on a server shared
 * with apps that publish their questionnaires elsewhere.
 *
 * Either way there is no form to render, so this falls back to showing the raw answers rather than an
 * error: the data is there and worth seeing, even unlabelled.
 */
function ResponseViewer(props: { response: QuestionnaireResponse; onClose: () => void }) {
  const { response, onClose } = props;
  const config = useConfig();

  const canonical = response.questionnaire;

  const {
    data: questionnaire,
    isPending,
    error
  } = useQuery({
    queryKey: ['questionnaire-by-canonical', config.formsServerUrl, canonical],
    queryFn: ({ signal }) => fetchQuestionnaireByCanonical(config.formsServerUrl, canonical!, signal),
    enabled: canonical !== undefined,
    retry: false
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{responseTitle(response)}</CardTitle>
            <CardDescription>
              QuestionnaireResponse/{response.id} · read-only. Already stored on the server; there is
              nothing to accept here.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onClose} className="ml-auto">
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
              Labelled <span className="font-mono text-xs">PATAST</span> — recorded by the person
              themselves rather than by a clinician.
            </span>
          </Alert>
        ) : null}

        {isPending && canonical ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Resolving the form definition…
          </p>
        ) : null}

        {!canonical || error ? (
          <>
            <Alert tone="warning" title="The form definition could not be resolved">
              {canonical ? (
                <>
                  This response cites{' '}
                  <span className="font-mono text-xs break-all">{canonical}</span>, which{' '}
                  <span className="font-mono text-xs">{config.formsServerUrl}</span> does not hold. That
                  is common on a shared server — responses cite whatever canonical the app that wrote
                  them used. The answers are shown as stored instead.
                </>
              ) : (
                <>
                  This response has no <span className="font-mono text-xs">questionnaire</span>{' '}
                  canonical, so there is no definition to render it against. The answers are shown as
                  stored instead.
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

function BackLink() {
  return (
    <RouterLink
      to="/"
      className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All forms
    </RouterLink>
  );
}
