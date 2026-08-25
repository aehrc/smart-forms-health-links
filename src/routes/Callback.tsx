import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { completeLaunch } from '@/auth/smartSession';
import { useSmart } from '@/auth/SmartContext';
import { LAUNCH_PATH, LAUNCH_SETUP_PATH } from '@/auth/routes';
import { takeReturnPath } from '@/auth/returnTo';
import { Alert } from '@/components/ui/alert';
import SmartRegistration from '@/components/SmartRegistration';

/**
 * Where the authorisation server sends the user back — this is the registered `redirect_uri`.
 *
 * Exchanges the authorisation code for a token, then leaves. Landing here should be momentary.
 *
 * Where it leaves *to* is whatever `returnTo` remembers, which is the screen the launch was started
 * from when a gate sent the user here, and the form list otherwise — a launch says *who* but never
 * *which form*, so with nothing remembered picking one is the first thing to do anyway.
 *
 * The launch context itself is not passed along in the URL. It lives on the session, and `RequestForm`
 * reads it from there; threading a patient through a query parameter would let a later navigation drop
 * it silently. The remembered path is storage rather than a parameter for the neighbouring reason —
 * `redirect_uri` is registered exactly and strips its query, so nothing can ride back through it.
 */
export default function Callback() {
  const navigate = useNavigate();
  const { setSession } = useSmart();
  const [error, setError] = useState<string | null>(null);

  /*
   * An authorisation code is single-use, so the exchange must happen exactly once. React 18+ runs
   * effects twice in StrictMode during development, and the second run would present a code the
   * server has already burned — which fails, and fails in a way that only reproduces in dev.
   */
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) {
      return;
    }
    exchanged.current = true;

    completeLaunch()
      .then((session) => {
        setSession(session);

        // `replace`, so the back button does not return to a callback URL whose code is spent.
        navigate(takeReturnPath(), { replace: true });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [navigate, setSession]);

  if (error) {
    /*
     * `invalid_scope` is the one failure whose fix is not in this app at all — it means the OAuth
     * client's registration does not allow what was requested, so nothing in `config.json` will help.
     * Matched on the error code rather than the prose, which every authorisation server words
     * differently.
     */
    const isScopeFailure = /invalid_scope/i.test(error);

    return (
      <div className="space-y-4 py-8">
        <h1 className="text-xl font-semibold text-slate-900">Sign-in failed</h1>
        <Alert tone="error" title="The launch could not be completed">
          <p>{error}</p>
          {isScopeFailure ? (
            <p className="mt-2">
              This is a <strong>client registration</strong> problem rather than a configuration one:
              the authorisation server is refusing scopes this client is not permitted to ask for.
              Register the full list below, or narrow what the app requests with{' '}
              <span className="font-mono text-xs">smartScopes</span>.
            </p>
          ) : null}
          <p className="mt-2">
            <a href={LAUNCH_PATH} className="underline">
              Try again
            </a>
            , or carry on without signing in — reading works either way, though nothing can be written
            until a launch completes.
          </p>
        </Alert>

        {/*
          * Inlined rather than linked. Somebody reading this has just had a launch fail and is looking
          * for what to change; making them navigate first is a step at which people give up.
          */}
        <SmartRegistration />

        <p className="text-xs text-slate-500">
          This is also at{' '}
          <a href={LAUNCH_SETUP_PATH} className="underline">
            {LAUNCH_SETUP_PATH}
          </a>
          , which is worth sending to whoever administers the OAuth client.
        </p>
      </div>
    );
  }

  return (
    <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Completing sign-in…
    </p>
  );
}
