import { useQuery } from "@tanstack/react-query";
import { Building2, LogIn, ScanLine } from "lucide-react";
import { Link as RouterLink } from "react-router-dom";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loading } from "@/components/ui/loading";
import {
  fetchIssuers,
  standaloneLaunchUrl,
  type LaunchReason,
} from "@/lib/session";

/**
 * The way in, and the only requester surface that renders without a session.
 *
 * It does two jobs that are the same job. As the standalone entry it lists the servers this
 * deployment is registered with and starts a SMART App Launch against the one chosen (FR-002).
 * As the re-launch prompt it is what a gated surface renders in place of itself, which is why
 * {@link ConnectProps.reason} exists: an expired session and a first visit want the same button
 * and different words, and neither may be a blank page or a raw error (spec US1 acceptance
 * scenario 4).
 *
 * Choosing a server is a full navigation, not a route change. `/launch` is a server route that
 * answers a redirect to the issuer's authorization endpoint, so a client-side route would simply
 * fail to find it.
 * @author John Grimes
 */

/** What to say above the picker. */
interface Preamble {
  readonly heading: string;
  readonly body: string;
  /** Rendered as a warning rather than as ordinary copy. */
  readonly tone?: "warning";
}

/**
 * The words for each reason a launch is being asked for.
 *
 * Kept as data rather than as branches in the component: the difference between these cases is
 * entirely what they say.
 */
const PREAMBLES: Record<LaunchReason, Preamble> = {
  "no-session": {
    heading: "Sign in to a clinical system",
    body:
      "This app works inside the record system it is launched from. Choose a server to sign " +
      "in to, and the forms, patients and responses it holds become available here.",
  },
  "session-expired": {
    heading: "Your session has ended",
    body:
      "Signing in again will pick up where you left off. Nothing was lost: everything this " +
      "app showed you lives on the server it was launched from.",
    tone: "warning",
  },
  "session-unavailable": {
    heading: "Whether you are signed in could not be checked",
    body:
      "The app could not reach its own server, so it cannot tell whether your session is " +
      "still good. Signing in again is the quickest way through this.",
    tone: "warning",
  },
};

/** Props for {@link Connect}. */
export interface ConnectProps {
  /** Why a launch is being asked for. Defaults to a plain first-visit invitation. */
  readonly reason?: LaunchReason;
}

/**
 * The launch prompt.
 * @param root0 the component props
 * @param root0.reason why a launch is being asked for
 * @returns the issuer picker, with the words for that reason
 */
export default function Connect({ reason = "no-session" }: ConnectProps) {
  const {
    data: issuers,
    isPending,
    error,
  } = useQuery({
    queryKey: ["issuers"],
    queryFn: ({ signal }) => fetchIssuers(signal),
  });

  const preamble = PREAMBLES[reason];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {preamble.heading}
        </h1>
        {preamble.tone === undefined ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {preamble.body}
          </p>
        ) : null}
      </div>

      {preamble.tone === undefined ? null : (
        <Alert tone={preamble.tone}>{preamble.body}</Alert>
      )}

      {error ? (
        <Alert tone="error" title="The list of servers could not be loaded">
          {error instanceof Error ? error.message : String(error)}
          <p className="mt-1">
            This is a problem with this app rather than with any clinical
            system. It is usually temporary - reload the page to try again.
          </p>
        </Alert>
      ) : null}

      {isPending ? (
        <Loading>Loading the servers you can sign in to…</Loading>
      ) : null}

      {issuers && issuers.length === 0 ? (
        <Alert tone="warning" title="No servers are registered">
          This deployment has an empty issuer registry, so there is nothing to
          sign in to. Whoever administers it has to register a server before
          this app can read anything.
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(issuers ?? []).map((option) => (
          <li key={option.issuer}>
            <Card className="transition-colors hover:border-slate-400 dark:hover:border-slate-600">
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <Building2
                  className="h-4 w-4 shrink-0 text-slate-400"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {option.label}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                    {option.issuer}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() =>
                    globalThis.location.assign(
                      standaloneLaunchUrl(option.issuer),
                    )
                  }
                >
                  <LogIn className="h-3.5 w-3.5" aria-hidden />
                  Sign in
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {/*
        The filler's half of the app needs no session at all, and someone who arrived here from a
        link they were sent should not be left thinking they have to sign in to answer it.
      */}
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Answering a form someone sent you? You do not need to sign in.{" "}
        <RouterLink
          to="/scan"
          className="inline-flex items-center gap-1 underline"
        >
          <ScanLine className="h-3.5 w-3.5" aria-hidden />
          Open their link
        </RouterLink>
      </p>
    </div>
  );
}
