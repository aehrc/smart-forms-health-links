import { useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ClipboardList, Loader2, Search, Send, User } from 'lucide-react';
import type { Patient } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import { patientDisplay, searchPatients } from '@/fhir/ehrServer';
import { useDebounced } from '@/lib/useDebounced';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Patients on the EHR.
 *
 * Two jobs, both about not typing references by hand. It picks the subject of a request — `Task.for`
 * wants a reference the requester's server can resolve *and* a display name, since a filler cannot
 * resolve a reference into a server it has no access to. And it filters the response list.
 *
 * `returnTo` carries the caller through, so choosing a patient goes back where you came from rather
 * than dead-ending here.
 */

const IHI_SYSTEM = 'http://ns.electronichealth.net.au/id/hi/ihi/1.0';

function identifierSummary(patient: Patient): string | undefined {
  const ihi = patient.identifier?.find((identifier) => identifier.system === IHI_SYSTEM)?.value;
  if (ihi) {
    return `IHI ${ihi}`;
  }

  const first = patient.identifier?.find((identifier) => identifier.value)?.value;
  return first ? `id ${first}` : undefined;
}

function describe(patient: Patient): string {
  return [
    patient.gender,
    patient.birthDate ? `born ${patient.birthDate}` : undefined,
    identifierSummary(patient)
  ]
    .filter(Boolean)
    .join(' · ');
}

export default function PatientList() {
  const config = useConfig();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebounced(searchText, 300);

  const ehrServerUrl = config.responseServerUrl;
  /*
   * Where to go once a patient is chosen. Restricted to an in-app path: this value comes from the URL,
   * so treating it as a destination without checking would let a crafted link bounce someone off-site.
   */
  const rawReturnTo = params.get('returnTo');
  const returnTo = rawReturnTo?.startsWith('/') && !rawReturnTo.startsWith('//') ? rawReturnTo : null;

  const {
    data: page,
    isPending,
    error
  } = useQuery({
    queryKey: ['ehr-patients', ehrServerUrl, debouncedSearch],
    queryFn: ({ signal }) => searchPatients(ehrServerUrl!, debouncedSearch, 50, signal),
    enabled: ehrServerUrl !== null
  });

  function choose(patient: Patient) {
    const reference = `Patient/${patient.id}`;
    const display = patientDisplay(patient);

    if (returnTo) {
      const separator = returnTo.includes('?') ? '&' : '?';
      navigate(
        `${returnTo}${separator}subject=${encodeURIComponent(reference)}&subjectDisplay=${encodeURIComponent(display)}`
      );
      return;
    }

    navigate(`/responses?subject=${encodeURIComponent(reference)}`);
  }

  if (!ehrServerUrl) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert tone="warning" title="No EHR server is configured">
          Set <span className="font-mono text-xs">responseServerUrl</span> in{' '}
          <span className="font-mono text-xs">config.json</span> — that is the server holding patients.
          The forms server is a catalogue of questionnaire definitions and holds none.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />

      <div>
        <h1 className="text-xl font-semibold text-slate-900">Patients</h1>
        <p className="text-sm text-slate-500">
          On <span className="font-mono text-xs">{ehrServerUrl}</span>
          {page?.total !== undefined ? ` · ${page.total} in total` : null}
          {returnTo ? ' · choose who the request is for' : null}
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

      {isPending ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading patients…
        </p>
      ) : null}

      {page && page.resources.length === 0 ? (
        <Alert title="No patients found">
          {debouncedSearch.trim() === ''
            ? 'This server holds no patients.'
            : `Nothing matched “${debouncedSearch}”.`}
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(page?.resources ?? []).map((patient) => (
          <li key={patient.id}>
            <Card className="transition-colors hover:border-slate-400">
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">{patientDisplay(patient)}</p>
                  <p className="truncate text-xs text-slate-500">
                    Patient/{patient.id}
                    {describe(patient) ? ` · ${describe(patient)}` : null}
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
                    to={`/responses?subject=${encodeURIComponent(`Patient/${patient.id}`)}`}>
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
