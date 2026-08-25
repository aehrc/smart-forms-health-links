import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useConfig } from '@/lib/ConfigContext';
import { canUseSmartLaunch } from '@/lib/config';
import { restoreSession, type SmartSession } from './smartSession';

/**
 * The current SMART session, or null when there is none.
 *
 * Mirrors `src/lib/ConfigContext.tsx` deliberately, with one difference that matters: `ConfigProvider`
 * renders nothing until config resolves, because an app pointed at no server can do nothing useful.
 * This provider must never do that. No session is the *normal* state — it is how every filler and
 * every unlaunched visitor uses the app — so blocking the tree on it would hide a working app behind a
 * check that will usually come back empty.
 */

interface SmartContextValue {
  session: SmartSession | null;
  /** False until the restore attempt has settled, so the UI can avoid flashing a signed-out state. */
  ready: boolean;
  setSession: (session: SmartSession | null) => void;
  signOut: () => void;
}

const SmartContext = createContext<SmartContextValue>({
  session: null,
  ready: true,
  setSession: () => {},
  signOut: () => {}
});

export function useSmart(): SmartContextValue {
  return useContext(SmartContext);
}

/** The session alone, for the many callers that only need to pass it to `authedFetch`. */
export function useSmartSession(): SmartSession | null {
  return useContext(SmartContext).session;
}

export function SmartProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const [session, setSession] = useState<SmartSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    /*
     * Skipped entirely when the feature is off, rather than attempted and allowed to fail. A
     * deployment that has never configured a launch should issue no discovery request and leave no
     * storage behind.
     */
    if (!canUseSmartLaunch(config)) {
      setReady(true);
      return;
    }

    restoreSession()
      .then((restored) => {
        if (!cancelled) {
          setSession(restored);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config]);

  const signOut = useCallback(() => {
    session?.signOut();
    setSession(null);
  }, [session]);

  return (
    <SmartContext.Provider value={{ session, ready, setSession, signOut }}>
      {children}
    </SmartContext.Provider>
  );
}

/**
 * The EHR base URL to read from and write to: the launched server if there is one, else configuration.
 *
 * Null means "nowhere is configured", which several routes render as an explanation rather than an
 * empty list. That was already true before launches existed; a launch simply adds a second way for it
 * to be non-null.
 *
 * Deliberately **not** used for `blobServerUrl` or `writeSlotServerUrl`. In the shipped config those
 * happen to be the same string as `responseServerUrl`, which makes this easy to get wrong: the blob
 * host and the write slot are transport, reachable by a filler who holds no credentials, and moving
 * them onto an authenticated server would break the link for exactly the person it was minted for.
 */
export function useEhrServerUrl(): string | null {
  const config = useConfig();
  const { session } = useSmart();
  return session?.serverUrl ?? config.responseServerUrl;
}
