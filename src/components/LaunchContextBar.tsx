import { Link as RouterLink } from 'react-router-dom';
import { CircleDashed, LogOut, Server, ShieldCheck, User } from 'lucide-react';
import { useEhrServerUrl, useSmart } from '@/auth/SmartContext';
import { useLaunchContext } from '@/auth/useLaunchContext';
import { describePatient, patientDisplay } from '@/fhir/ehrServer';
import { useConfig } from '@/lib/ConfigContext';
import { canUseSmartLaunch } from '@/lib/config';
import { LaunchLink, SetupLink } from '@/components/LaunchRequired';

/**
 * What this session is, in one strip under the nav.
 *
 * ## Why it is not in the nav
 *
 * It used to be, as `SessionBadge` — a name and a host in the last slot of a row that was already over
 * budget, wrapping to two lines signed in and three at 768px. The nav and the session were competing
 * for the same pixels while answering completely different questions: *where do I want to go* and *who
 * am I, on which record, right now*. Splitting them gives the second one room to say more than a name,
 * and gives the first its width back.
 *
 * ## Why it renders when there is nothing to report
 *
 * Unlike `ScopeWarning` beneath it, which is silent until something is wrong. "No session" is not an
 * empty state here, it is a *fact about what the next click can do* — reads work, writes do not — and a
 * strip that vanished would answer the question only when the answer was reassuring. It is also the
 * only place the unlaunched user is offered a launch at all, now that the nav carries no badge.
 */
export default function LaunchContextBar() {
  const config = useConfig();
  const { session, ready, signOut } = useSmart();
  const ehrServerUrl = useEhrServerUrl();
  const { patient, patientReference, user, userDisplay } = useLaunchContext();

  const host = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  return (
    <div className="border-b border-slate-200 bg-slate-50">
      {/*
        * `min-h` rather than a bare height, and the same `max-w-5xl px-4` container as the header and
        * the main column so the chips line up with the content they describe.
        *
        * The minimum is what keeps the restore flicker out of the layout. A session is recovered
        * asynchronously on every page load, so the choice is between rendering nothing (the page jumps
        * once the answer arrives) and rendering a wrong answer (it says "not launched" and then
        * corrects itself). Reserving the space and filling it late does neither.
        */}
      <div className="mx-auto flex min-h-10 max-w-5xl flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 text-xs">
        {!ready ? null : session ? (
          <>
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-900"
              title={session.fhirUser ?? 'The launch granted no user identity'}>
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="max-w-48 truncate font-medium">
                {/*
                  * A name, else the raw reference, else a bare acknowledgement — never nothing.
                  * "Signed in as somebody" is the exact ambiguity this strip exists to remove, and
                  * `fhirUser` can legitimately be absent when the scope was not granted.
                  */}
                {userDisplay ?? session.fhirUser ?? 'Signed in'}
              </span>
              {/*
                * `fhirUser` may name a Patient rather than a Practitioner. Labelling one as the other
                * would be a lie in the one place a clinician looks to check who they are acting as, so
                * the label follows the resource and is omitted when the resource could not be read.
                */}
              {user ? <span className="text-emerald-700/70">{user.resourceType}</span> : null}
            </span>

            {patientReference ? (
              <RouterLink
                to={`/responses?subject=${encodeURIComponent(patientReference)}`}
                title={`${patientReference} — see what this patient has already answered`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-200/70 px-2.5 py-1 text-slate-800 hover:bg-slate-300/70">
                <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="max-w-48 truncate font-medium">
                  {patient ? patientDisplay(patient) : patientReference}
                </span>
                {patient && describePatient(patient) !== '' ? (
                  <span className="hidden max-w-56 truncate text-slate-600 sm:inline">
                    {describePatient(patient)}
                  </span>
                ) : null}
              </RouterLink>
            ) : null}

            <span
              className="inline-flex items-center gap-1.5 text-slate-500"
              title={`Reads and writes go to ${session.serverUrl}`}>
              <Server className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="max-w-56 truncate font-mono">{host(session.serverUrl)}</span>
            </span>

            <span className="ml-auto flex items-center gap-x-3">
              <SetupLink iconClassName="h-3.5 w-3.5" className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-900" />
              <button
                type="button"
                onClick={signOut}
                className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-900">
                <LogOut className="h-3.5 w-3.5" aria-hidden />
                Sign out
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <CircleDashed className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="font-medium">Not launched</span>
              {/*
                * Says what still works, not only what does not. Read-only is the accurate and the more
                * useful description: somebody who has just been refused a write needs to know whether
                * the screen they are on is broken or merely limited.
                */}
              {ehrServerUrl ? (
                <span>
                  — reading <span className="font-mono">{host(ehrServerUrl)}</span> anonymously,
                  read-only.
                </span>
              ) : (
                <span>— no record server is configured, so there is nothing to read or write.</span>
              )}
            </span>

            <span className="ml-auto flex items-center gap-x-3">
              {canUseSmartLaunch(config) ? (
                <LaunchLink iconClassName="h-3.5 w-3.5" className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-slate-900" />
              ) : null}
              <SetupLink iconClassName="h-3.5 w-3.5" className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-900" />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
