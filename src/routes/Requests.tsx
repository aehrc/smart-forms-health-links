import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Clock, Inbox, XCircle } from "lucide-react";
import { Link as RouterLink } from "react-router-dom";

import Connect from "./Connect";

import type { Task } from "fhir/r4";

import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loading } from "@/components/ui/loading";
import { searchPublishedRequests } from "@/fhir/ehrServer";
import { FHIR_PROXY_BASE, useRequesterGate } from "@/lib/session";
import { taskCorrelationId } from "@/link/exchange";

/**
 * Requests this organisation has sent, and what has come back.
 *
 * The list is now one source: the request Tasks published on the launched server (FR-011). That
 * is a deliberate narrowing. It used to be the union of those Tasks and a browser-local store,
 * because answers arrived through an encrypted reply slot whose key existed in exactly one
 * browser - so a request sent from a colleague's machine was visible here and not collectable
 * here, and the list had to explain that.
 *
 * Nothing needs explaining now. Answers land directly on the launched server, so a request's
 * state is the state of its Task, and everybody signed in to that server sees the same thing.
 * There is no local key to hold, nothing to export between browsers, and nothing to poll: a
 * filler completing a form updates the Task, and this list reflects it.
 * @author John Grimes
 */

/** Rows fetched at once. */
const PAGE_SIZE = 50;

/**
 * The form a Task was asking for, as a label.
 *
 * `buildRequestBundle` writes `Complete "<title>"` into `description`, so the title is recovered
 * from it rather than showing the instruction as though it were a form name.
 * @param task the published request Task
 * @returns the best available label for it
 */
function requestLabel(task: Task): string {
  const description = task.description;
  if (description) {
    const quoted = /"([^"]+)"/.exec(description);
    return quoted?.[1] ?? description;
  }

  const canonical =
    task.input?.find((input) => input.valueCanonical)?.valueCanonical ??
    task.focus?.reference;
  if (canonical) {
    return canonical.split("|", 1)[0].split("/").findLast(Boolean) ?? canonical;
  }

  return "Requested form";
}

/**
 * The sent-requests list.
 * @returns the list, a launch prompt, or a loading line
 */
export default function Requests() {
  const {
    data: page,
    isPending,
    error,
  } = useQuery({
    queryKey: ["published-requests", PAGE_SIZE],
    queryFn: ({ signal }) =>
      searchPublishedRequests(FHIR_PROXY_BASE, PAGE_SIZE, signal),
  });

  const gate = useRequesterGate(error);

  if (gate.kind === "loading") {
    return <Loading>Checking your session…</Loading>;
  }
  if (gate.kind === "launch-required") {
    return <Connect reason={gate.reason} />;
  }

  return (
    <div className="space-y-4">
      <RouterLink
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All forms
      </RouterLink>

      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Sent requests
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Published to {gate.session.issuerLabel}
          {page?.total === undefined ? null : ` · ${page.total} in total`}
        </p>
      </div>

      <Alert title="Answers arrive on the server">
        A completed form is written straight to {gate.session.issuerLabel} by
        the person answering it, so there is nothing here to collect and nothing
        to poll. A request shows as completed once its answers have landed -
        look for them under{" "}
        <RouterLink to="/responses" className="underline">
          Responses
        </RouterLink>
        .
      </Alert>

      {error ? (
        <Alert tone="error" title="Could not load sent requests">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      ) : null}

      {isPending ? <Loading>Loading sent requests…</Loading> : null}

      {page && page.resources.length === 0 ? (
        <Alert title="Nothing sent yet">
          Create a request from a form and it will appear here, along with
          whether it has been answered.
        </Alert>
      ) : null}

      <div className="space-y-3">
        {(page?.resources ?? []).map((task) => (
          <RequestRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

/**
 * One sent request.
 * @param root0 the component props
 * @param root0.task the published request Task
 * @returns the row
 */
function RequestRow({ task }: Readonly<{ task: Task }>) {
  const requestId = taskCorrelationId(task);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{requestLabel(task)}</CardTitle>
            <CardDescription>
              {task.authoredOn
                ? `Sent ${new Date(task.authoredOn).toLocaleString()}`
                : "Sent"}
              {task.for?.display ? ` · for ${task.for.display}` : null}
              {task.requester?.display
                ? ` · by ${task.requester.display}`
                : null}
            </CardDescription>
          </div>

          <div className="ml-auto">
            <StatusBadge status={task.status} />
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-[auto_1fr] dark:text-slate-400">
          {requestId ? (
            <>
              <dt className="font-medium">Reference</dt>
              <dd className="font-mono break-all">{requestId}</dd>
            </>
          ) : null}
          <dt className="font-medium">Published Task</dt>
          <dd className="font-mono break-all">Task/{task.id}</dd>
          {task.for?.reference ? (
            <>
              <dt className="font-medium">Subject</dt>
              <dd className="font-mono break-all">{task.for.reference}</dd>
            </>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Task states that mean the request will never be answered. */
const ABANDONED_STATUSES = new Set<Task["status"]>([
  "cancelled",
  "failed",
  "rejected",
]);

/**
 * The Task's own status, shown as it stands on the server.
 *
 * Deliberately not reinterpreted. `requested` means nobody has answered yet, `completed` means a
 * filler wrote answers back, and everything else is a state the server or another app put the
 * Task into - which is worth showing verbatim rather than flattening into "pending".
 * @param root0 the component props
 * @param root0.status the Task's status, as the server holds it
 * @returns the badge
 */
function StatusBadge({ status }: Readonly<{ status: Task["status"] }>) {
  const { tone, icon: Icon } = describeStatus(status);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {status === "requested" ? "Awaiting answers" : status}
    </span>
  );
}

/**
 * The colour and icon for a Task status.
 * @param status the Task's status
 * @returns the badge classes and the icon to draw in it
 */
function describeStatus(status: Task["status"]): {
  tone: string;
  icon: typeof Inbox;
} {
  if (status === "completed") {
    return {
      tone: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100",
      icon: CheckCircle2,
    };
  }
  if (ABANDONED_STATUSES.has(status)) {
    return {
      tone: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
      icon: XCircle,
    };
  }
  return {
    tone: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    icon: status === "requested" ? Clock : Inbox,
  };
}
