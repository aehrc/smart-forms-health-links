import { useQuery } from '@tanstack/react-query';
import { LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { useSmart } from '@/auth/SmartContext';
import { LAUNCH_PATH } from '@/auth/routes';
import { useConfig } from '@/lib/ConfigContext';
import { canUseSmartLaunch } from '@/lib/config';
import { fetchUserDisplay } from '@/fhir/ehrServer';

/**
 * Who is signed in, and to which server — or an invitation to sign in when nobody is.
 *
 * Worth showing rather than leaving implicit. Once a launch is possible, the same screen writes to
 * different servers as different people depending on a session the user cannot otherwise see, and a
 * clinician about to save a patient's answers should be able to tell which record they are writing to.
 *
 * Renders nothing at all when launches are not configured, so the unauthenticated deployment gains no
 * chrome it has no use for.
 */
export default function SessionBadge() {
  const config = useConfig();
  const { session, ready, signOut } = useSmart();

  const { data: userName } = useQuery({
    queryKey: ['fhirUser', session?.serverUrl, session?.fhirUser],
    queryFn: ({ signal }) => fetchUserDisplay(session!.serverUrl, session!.fhirUser!, signal, session),
    enabled: !!session?.fhirUser
  });

  if (!canUseSmartLaunch(config)) {
    return null;
  }

  // Held back until the restore attempt settles, so a signed-in user does not see "Sign in" flash past.
  if (!ready) {
    return null;
  }

  if (!session) {
    return (
      <a
        href={LAUNCH_PATH}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
        <LogIn className="h-4 w-4" aria-hidden />
        Sign in
      </a>
    );
  }

  /*
   * The name if the server would give one, otherwise the raw reference. Never nothing: "signed in as
   * somebody" is exactly the ambiguity this component exists to remove.
   */
  const who = userName ?? session.fhirUser ?? 'Signed in';
  const where = new URL(session.serverUrl).host;

  return (
    <div className="flex items-center gap-1">
      <span
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-900"
        title={`${session.fhirUser ?? 'Unknown user'} at ${session.serverUrl}`}>
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
        <span className="max-w-40 truncate">{who}</span>
        <span className="text-emerald-700/70">· {where}</span>
      </span>
      <button
        type="button"
        onClick={signOut}
        title="Sign out"
        className="inline-flex items-center rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
        <LogOut className="h-4 w-4" aria-hidden />
        <span className="sr-only">Sign out</span>
      </button>
    </div>
  );
}
