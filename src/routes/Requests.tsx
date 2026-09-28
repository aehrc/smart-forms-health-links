import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ClipboardList,
  Inbox,
  Loader2,
  QrCode,
  RefreshCw,
} from "lucide-react";
import { Link as RouterLink } from "react-router-dom";

import { useEhrServerUrl, useSmartSession } from "@/auth/SmartContext";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { searchPublishedRequests } from "@/fhir/ehrServer";
import { canTrackRequests } from "@/lib/config";
import { useConfig } from "@/lib/configContextValue";
import { describeSentRequests, type SentRequest } from "@/lib/sentRequests";

/**
 * Requests this app has sent, and what has come back.
 *
 * One query over the request Tasks published on the launched server, because that is where a
 * request's state lives: minting publishes the Task, and both return routes complete it with the
 * answers as its output (FR-011). Nothing is held in this browser, so there is nothing to poll,
 * nothing to import from a colleague's machine and nothing to lose by clearing site data - a
 * request sent from any browser reads the same here as it does there.
 *
 * The derivation is in `src/lib/sentRequests.ts`, which is pure and tested; this file is the view
 * over it.
 */

/**
 * What to call the state a request is in.
 *
 * `closed` names the Task's own status rather than paraphrasing it: "cancelled" and "rejected" are
 * different facts, and which one it was is the useful part.
 * @param request the row
 * @returns the badge text
 */
function statusLabel(request: SentRequest): string {
  /*
   * A standing request is checked before the Task's own status, because its status is always
   * `requested` and always will be: no walk-in completes the request that serves the next one.
   * Reporting it as awaiting answers would be true of the resource and misleading about the
   * practice, whose walk-in answers are arriving in the queue on `/walk-ins`.
   */
  if (request.standing) {
    return "Walk-in code";
  }
  if (request.state === "answered") {
    return "Answers received";
  }
  if (request.state === "closed") {
    return request.status === "entered-in-error"
      ? "Entered in error"
      : request.status.charAt(0).toUpperCase() + request.status.slice(1);
  }

  return "Awaiting answers";
}

/**
 * How to colour that badge.
 * @param state the row's state
 * @returns the Tailwind classes for the badge
 */
function statusTone(state: SentRequest["state"] | "standing"): string {
  if (state === "standing") return "bg-sky-100 text-sky-900";
  if (state === "answered") return "bg-green-100 text-green-800";
  if (state === "closed") return "bg-amber-100 text-amber-900";
  return "bg-slate-100 text-slate-600";
}

/**
 * Where to send a reviewer who wants to read the answers a request received.
 *
 * The response list filtered to the patient the request names, rather than the response itself:
 * there is no route that opens one response by id, and the filtered list is one click from it.
 * @param request the row
 * @returns the in-app path
 */
function answersPath(request: SentRequest): string {
  if (request.standing) {
    return "/walk-ins";
  }
  return request.subjectReference?.startsWith("Patient/")
    ? `/responses?subject=${encodeURIComponent(request.subjectReference)}`
    : "/responses";
}

/**
 * The icon beside a row's state badge, when the state has one worth showing.
 * @param props the component props
 * @param props.request the row
 * @returns the icon, or null for a state that needs no glyph
 */
function StatusIcon({ request }: Readonly<{ request: SentRequest }>) {
  if (request.standing) {
    return <QrCode className="h-3 w-3" aria-hidden />;
  }
  if (request.state === "answered") {
    return <Inbox className="h-3 w-3" aria-hidden />;
  }
  return null;
}

/**
 * One row: a published request Task, and what its state says about it.
 * @param props.request the row to render
 * @param root0
 * @param root0.request
 * @returns the card
 */
function RequestRow({ request }: { request: SentRequest }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{request.label}</CardTitle>
            <CardDescription>
              {request.createdAt
                ? `Sent ${new Date(request.createdAt).toLocaleString()}`
                : "Sent"}
              {request.subjectDisplay
                ? ` · for ${request.subjectDisplay}`
                : null}
              {request.requesterDisplay
                ? ` · by ${request.requesterDisplay}`
                : null}
            </CardDescription>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(request.standing ? "standing" : request.state)}`}
            >
              <StatusIcon request={request} />
              {statusLabel(request)}
            </span>
            {request.standing || request.state === "answered" ? (
              <RouterLink to={answersPath(request)}>
                <Button variant="outline" size="sm">
                  <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                  {request.standing ? "Walk-in queue" : "View answers"}
                </Button>
              </RouterLink>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">Reference</dt>
          <dd className="font-mono break-all">{request.id}</dd>
          {request.taskId ? (
            <>
              <dt className="font-medium">Published Task</dt>
              <dd className="font-mono break-all">Task/{request.taskId}</dd>
            </>
          ) : null}
          {request.responseReference ? (
            <>
              <dt className="font-medium">Answers</dt>
              <dd className="font-mono break-all">
                {request.responseReference}
              </dd>
            </>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * The sent-requests page.
 * @returns the page
 */
export default function Requests() {
  const config = useConfig();
  const ehrServerUrl = useEhrServerUrl();
  const session = useSmartSession();
  const tracking = canTrackRequests(config, ehrServerUrl);

  /*
   * The issuer for display, the proxy for fetching. `useEhrServerUrl` is this app's own proxy path
   * under the BFF - correct to build a request against, and meaningless to show somebody - so the
   * two are named separately here rather than one standing in for the other.
   */
  const issuer = session?.issuer ?? "the launched server";

  const {
    data: page,
    isPending,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ["published-requests", ehrServerUrl, session?.fhirUser ?? null],
    queryFn: ({ signal }) => searchPublishedRequests(ehrServerUrl!, 50, signal),
    enabled: tracking,
    retry: false,
  });

  const requests = describeSentRequests(page?.resources ?? []);

  return (
    <div className="space-y-4">
      <RouterLink
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All forms
      </RouterLink>

      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Sent requests
          </h1>
          <p className="text-sm text-slate-500">
            {tracking ? (
              <>
                Request Tasks published to{" "}
                <span className="font-mono text-xs">{issuer}</span>
                {page?.total === undefined ? null : ` · ${page.total} in total`}
              </>
            ) : (
              "Request publishing is off, so sent requests are not recorded anywhere to list."
            )}
          </p>
        </div>

        {tracking ? (
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
              Refresh
            </Button>
          </div>
        ) : null}
      </div>

      <Alert title="Answers come back to the server, not to this browser">
        A request carries a short-lived credential for{" "}
        {session?.issuerLabel ?? "the launched server"}, so answers are written
        there as soon as they are sent and the request is marked completed.
        Nothing is held in this browser, so a request sent from any other
        browser appears here just the same.
      </Alert>

      {error ? (
        <Alert tone="error" title="Could not list published requests">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      ) : null}

      {tracking && isPending ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading sent requests…
        </p>
      ) : null}

      {!isPending && !error && requests.length === 0 ? (
        <Alert title="Nothing sent yet">
          Create a request from a form and it will appear here, with whatever
          has come back for it.
        </Alert>
      ) : null}

      <div className="space-y-3">
        {requests.map((request) => (
          <RequestRow key={request.id} request={request} />
        ))}
      </div>
    </div>
  );
}
