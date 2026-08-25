import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { completeLaunch } from '@/auth/smartSession';
import { useSmart } from '@/auth/SmartContext';
import { LAUNCH_PATH } from '@/auth/routes';
import { Alert } from '@/components/ui/alert';

/**
 * Where the authorisation server sends the user back — this is the registered `redirect_uri`.
 *
 * Exchanges the authorisation code for a token, then leaves. Landing here should be momentary; the
 * user's destination depends on what the launch supplied:
 *
 * Always to the form list, because a launch says *who* but never *which form* — picking one is the
 * first thing the clinician has to do either way. The patient in context is not passed along in the
 * URL: it lives on the session, and `RequestForm` reads it from there. Threading it through a query
 * parameter would let a later navigation drop it silently.
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
        navigate('/', { replace: true });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [navigate, setSession]);

  if (error) {
    return (
      <div className="py-8">
        <h1 className="mb-3 text-xl font-semibold text-slate-900">Sign-in failed</h1>
        <Alert tone="error" title="The launch could not be completed">
          <p>{error}</p>
          <p className="mt-2">
            <a href={LAUNCH_PATH} className="underline">
              Try again
            </a>
            , or carry on without signing in — the app works unauthenticated.
          </p>
        </Alert>
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
