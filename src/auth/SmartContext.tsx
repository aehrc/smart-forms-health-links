/**
 * The current launched session, or null when there is none.
 *
 * Mirrors `src/lib/ConfigContext.tsx` deliberately, with one difference that matters:
 * `ConfigProvider` renders nothing until config resolves, because an app pointed at no terminology
 * server can do little useful. This provider must never do that. No session is a *working* state,
 * not a broken one - it is how every filler uses the app - so blocking the tree on it would hide a
 * working app behind a check that will often come back empty. Writing is what a missing session
 * refuses, and that refusal belongs at the call sites that write, not here. See `canWriteToRecord`
 * in `src/lib/config.ts`.
 *
 * There is no `setSession` any more, and its absence is the architecture. The session is created by
 * the BFF during `/callback` and handed to the browser as an `HttpOnly` cookie, so nothing in React
 * can put a session into scope - it can only ask `/api/session` what the cookie is worth. What used
 * to be a state setter is now a cache invalidation, which is `useLogout`'s job.
 */

/*
 * The provider and the hooks that read it live together on purpose: they share a module-private
 * context object, and splitting them would mean exporting that object from a third module so both
 * halves could import it - which is a wider surface than the fast-refresh boundary is worth. The
 * cost is that editing this file does a full reload rather than a hot swap.
 */
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from "react";

import { toSmartSession, type SmartSession } from "./smartSession";

import { useLogout, useSession } from "@/lib/session";

interface SmartContextValue {
  session: SmartSession | null;
  /**
   * False until the first `/api/session` read has settled, so the UI can avoid flashing a
   * signed-out state at somebody who is in fact signed in.
   */
  ready: boolean;
  signOut: () => void;
}

const SmartContext = createContext<SmartContextValue>({
  session: null,
  ready: true,
  signOut: () => {},
});

/**
 *
 */
export function useSmart(): SmartContextValue {
  return useContext(SmartContext);
}

/** The session alone, for the many callers that only need to pass it to `authedFetch`. */
export function useSmartSession(): SmartSession | null {
  return useContext(SmartContext).session;
}

/**
 * Provide the session to the tree.
 *
 * A thin adaptor over `useSession`, which is the one place `/api/session` is read and cached. Both
 * layers exist on purpose: `useSession` answers "what is known about the session", including the
 * `unavailable` case a gate needs to distinguish from "signed out", while this context answers the
 * narrower question the FHIR call sites ask - "is there a session, and what do I address".
 * @param props.children the tree to provide to
 * @param root0
 * @param root0.children
 * @returns the provider
 */
export function SmartProvider({ children }: { children: ReactNode }) {
  const state = useSession();
  const logout = useLogout();

  const session =
    state.kind === "active" ? toSmartSession(state.session) : null;

  return (
    <SmartContext.Provider
      value={{
        session,
        ready: state.kind !== "loading",
        signOut: () => {
          logout.mutate();
        },
      }}
    >
      {children}
    </SmartContext.Provider>
  );
}

/**
 * Where the requester's FHIR traffic is addressed.
 *
 * Under the BFF this is the session's `serverUrl` - the proxy - or null when there is no session,
 * and the null case is now absolute. It used to fall back to a configured `responseServerUrl`, so
 * that the requester's surfaces could read a public server anonymously; there is no such server to
 * fall back to now, and no anonymous read to make. Callers that treated null as "show an empty
 * state" are correct unchanged; callers that treated it as "read anonymously" no longer have that
 * option, which is what `requesterGate` exists to say out loud.
 * @returns the FHIR base to address, or null when nobody is signed in
 */
export function useEhrServerUrl(): string | null {
  const { session } = useSmart();
  return session?.serverUrl ?? null;
}
