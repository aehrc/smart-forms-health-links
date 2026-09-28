import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Loader2,
  Plus,
  QrCode,
  Search,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";

import Connect from "./Connect";

import type { QuestionnaireResponse } from "fhir/r4";

import ReviewResponse from "@/components/ReviewResponse";
import ShareLinkPanel from "@/components/ShareLinkPanel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { searchWalkInResponses } from "@/fhir/ehrServer";
import {
  fetchQuestionnaireByCanonical,
  searchQuestionnaires,
} from "@/fhir/formsServer";
import { resolveExpiry } from "@/lib/config";
import { useConfig } from "@/lib/configContextValue";
import { FHIR_PROXY_BASE, useRequesterGate } from "@/lib/session";
import {
  createStandingInvitation,
  listStandingInvitations,
  revokeStandingInvitation,
  standingState,
  viewerLinkFor,
  type StandingInvitation,
} from "@/lib/standingInvitations";
import { useDebounced } from "@/lib/useDebounced";

/**
 * Walk-ins: the codes a practice prints, and the answers they bring in.
 *
 * Two halves of one job, on one page, because they are read in that order. A new patient scans the
 * poster at the counter and fills the form in on their own phone; their answers arrive here,
 * belonging to nobody, and a receptionist decides whose they are.
 *
 * **Why the answers wait.** Everything on a per-patient request is vouched for by the person who
 * sent it: the practice chose the patient and addressed the link to them. Nothing about a printed
 * code is vouched for by anyone - whoever photographed the poster can fill it in - so the answers
 * reach the practice's server untriaged and subject-less, labelled with the walk-in tag, and this
 * queue is a search on that tag. Attaching them to a patient removes the tag, which is what takes
 * an item out of the queue: the tag *is* the state, so there is nothing else to keep in step.
 *
 * **Why the code is not a request.** The codes half lists this app's own hosting rows rather than
 * published Tasks, because what a practice needs to know about a poster - how many people have
 * scanned it, when it stops working, and whether staff have withdrawn it - is not on the Task. The
 * standing Task still exists, and `/requests` shows it as a walk-in code rather than as a request
 * waiting for an answer that will never come.
 * @author John Grimes
 */

/**
 * How a code's state should read, and how it should look.
 * @param link the code
 * @returns the badge text and its classes
 */
function stateBadge(link: StandingInvitation): {
  text: string;
  tone: string;
} {
  switch (standingState(link)) {
    case "revoked": {
      return { text: "Withdrawn", tone: "bg-amber-100 text-amber-900" };
    }
    case "expired": {
      return { text: "Expired", tone: "bg-slate-100 text-slate-600" };
    }
    default: {
      return { text: "Live", tone: "bg-green-100 text-green-800" };
    }
  }
}

/**
 * A date a person can read, from epoch seconds.
 * @param seconds the instant, or null when there is not one
 * @returns the local date and time, or "never"
 */
function whenText(seconds: number | null): string {
  return seconds === null ? "never" : new Date(seconds * 1000).toLocaleString();
}

/**
 * One item in the review queue: the answers, and the review that files them.
 * @param props the component props
 * @param props.response the untriaged answers, as the server holds them
 * @param props.onFiled called once the answers have been attached to somebody
 * @returns the card
 */
function QueueItem({
  response,
  onFiled,
}: Readonly<{
  response: QuestionnaireResponse;
  onFiled: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const canonical = response.questionnaire;

  /*
   * The form definition, so the answers render as questions rather than as link ids. Resolved only
   * once the item is opened: a queue of twenty would otherwise fetch twenty definitions nobody has
   * asked to look at. A canonical that will not resolve is normal rather than exceptional, and
   * `ReviewResponse` renders the answers without it.
   */
  const { data: questionnaire, error } = useQuery({
    queryKey: ["walk-in-form", canonical],
    queryFn: ({ signal }) =>
      fetchQuestionnaireByCanonical(FHIR_PROXY_BASE, canonical!, signal),
    enabled: open && canonical !== undefined,
    retry: false,
  });

  const stored = response.meta?.lastUpdated;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {response.questionnaire ?? "Answers"}
            </CardTitle>
            <CardDescription>
              {stored
                ? `Arrived ${new Date(stored).toLocaleString()}`
                : "Arrived from a walk-in code"}
              {" · nobody attached yet"}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setOpen((was) => !was)}
          >
            <UserRound className="h-3.5 w-3.5" aria-hidden />
            {open ? "Close" : "Review and attach"}
          </Button>
        </div>
      </CardHeader>

      {open ? (
        <CardContent>
          <ReviewResponse
            questionnaire={questionnaire}
            questionnaireError={
              error instanceof Error ? error.message : undefined
            }
            response={response}
            /*
             * Already on the server, so accepting updates it where it lies. Creating a second copy
             * with a subject on it would leave two records of one person filling one form in.
             */
            savedAs={{
              serverUrl: FHIR_PROXY_BASE,
              responseId: response.id!,
            }}
            /*
             * The whole point of the walk-in case: at the moment the code was scanned the practice
             * held no record of this person, so registering them is the expected outcome.
             */
            allowPatientCreation
            onSaved={onFiled}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * The review queue, in whichever of its three states it is in.
 * @param props the component props
 * @param props.isPending whether the search is still running
 * @param props.waiting the untriaged answers
 * @param props.onFiled called once one of them has been attached to somebody
 * @returns the queue
 */
function Queue({
  isPending,
  waiting,
  onFiled,
}: Readonly<{
  isPending: boolean;
  waiting: QuestionnaireResponse[];
  onFiled: () => void;
}>) {
  if (isPending) {
    return <Loading>Loading the queue…</Loading>;
  }
  if (waiting.length === 0) {
    return (
      <Alert title="Nothing waiting">
        No answers have arrived from a walk-in code that somebody has not
        already dealt with.
      </Alert>
    );
  }
  return (
    <div className="space-y-3">
      {waiting.map((response) => (
        <QueueItem key={response.id} response={response} onFiled={onFiled} />
      ))}
    </div>
  );
}

/**
 * Create a walk-in code: pick a form, mint it, print what comes back.
 * @param props the component props
 * @param props.onCreated called with the new code once it exists
 * @returns the picker
 */
function CreateCode({
  onCreated,
}: Readonly<{ onCreated: (link: StandingInvitation) => void }>) {
  const config = useConfig();
  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebounced(searchText, 300);
  const [error, setError] = useState<string | null>(null);

  const { data: questionnaires, isPending } = useQuery({
    queryKey: ["walk-in-questionnaires", debouncedSearch],
    queryFn: ({ signal }) =>
      searchQuestionnaires(FHIR_PROXY_BASE, debouncedSearch, 20, signal),
  });

  const create = useMutation({
    mutationFn: (questionnaireId: string) =>
      createStandingInvitation(questionnaireId, {
        expiresAt: resolveExpiry(config),
        senderName: config.senderName,
      }),
    onSuccess: (link) => {
      setError(null);
      onCreated(link);
    },
    onError: (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    },
  });

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <Input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Search the forms this practice publishes"
          className="pl-9"
          aria-label="Search forms"
        />
      </div>

      {error ? (
        <Alert tone="error" title="Could not create the code">
          {error}
        </Alert>
      ) : null}

      {isPending ? (
        <Loading>Loading forms…</Loading>
      ) : (
        <ul className="space-y-1.5">
          {(questionnaires ?? []).slice(0, 8).map((questionnaire) => (
            <li
              key={questionnaire.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800"
            >
              <span className="min-w-0 truncate text-sm text-slate-800 dark:text-slate-200">
                {questionnaire.title ?? questionnaire.name ?? questionnaire.id}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={create.isPending}
                onClick={() => create.mutate(questionnaire.id!)}
              >
                {create.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <QrCode className="h-3.5 w-3.5" aria-hidden />
                )}
                Create code
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The walk-ins surface.
 * @returns the queue, the codes, a launch prompt, or a loading line
 */
export default function WalkIns() {
  const config = useConfig();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<StandingInvitation | null>(null);
  const [printing, setPrinting] = useState<StandingInvitation | null>(null);

  const queue = useQuery({
    queryKey: ["walk-in-queue"],
    queryFn: ({ signal }) => searchWalkInResponses(FHIR_PROXY_BASE, 50, signal),
  });

  const codes = useQuery({
    queryKey: ["walk-in-codes"],
    queryFn: ({ signal }) => listStandingInvitations(signal),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeStandingInvitation(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["walk-in-codes"] }),
  });

  const gate = useRequesterGate(queue.error ?? codes.error);
  if (gate.kind === "loading") {
    return <Loading>Checking your session…</Loading>;
  }
  if (gate.kind === "launch-required") {
    return <Connect reason={gate.reason} />;
  }

  const waiting = queue.data?.resources ?? [];
  const shown = printing ?? minted;

  return (
    <div className="space-y-6">
      <div>
        <RouterLink
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          All forms
        </RouterLink>
        <h1 className="mt-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          Walk-ins
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Answers from the codes on your counter, and the codes themselves.
          Nobody vouched for who filled these in, so they wait here until
          somebody attaches them to a patient.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Awaiting review
          {waiting.length > 0 ? ` (${String(waiting.length)})` : ""}
        </h2>

        <Queue
          isPending={queue.isPending}
          waiting={waiting}
          onFiled={() => {
            void client.invalidateQueries({ queryKey: ["walk-in-queue"] });
            void client.invalidateQueries({ queryKey: ["walk-in-codes"] });
          }}
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Walk-in codes
          </h2>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setCreating((was) => !was)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {creating ? "Cancel" : "New code"}
          </Button>
        </div>

        {creating ? (
          <Card>
            <CardContent className="pt-6">
              <CreateCode
                onCreated={(link) => {
                  setCreating(false);
                  setPrinting(null);
                  setMinted(link);
                  void client.invalidateQueries({
                    queryKey: ["walk-in-codes"],
                  });
                }}
              />
            </CardContent>
          </Card>
        ) : null}

        {shown ? (
          <div className="space-y-2">
            <Alert title={`Code for ${shown.label}`}>
              Print this and put it where new patients will see it. It keeps
              working until {whenText(shown.expiresAt)}, whatever happens to the
              one-hour credential inside it.
            </Alert>
            <ShareLinkPanel
              link={viewerLinkFor(shown, config)}
              kind="request"
            />
          </div>
        ) : null}

        {codes.isPending ? <Loading>Loading codes…</Loading> : null}
        {!codes.isPending && (codes.data ?? []).length === 0 ? (
          <Alert title="No codes yet">
            Create one and print its QR to let new patients fill a form in
            without anyone at the desk typing their details.
          </Alert>
        ) : null}
        {(codes.data ?? []).length > 0 ? (
          <div className="space-y-3">
            {(codes.data ?? []).map((link) => {
              const badge = stateBadge(link);
              return (
                <Card key={link.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0">
                        <CardTitle className="text-base">
                          {link.label}
                        </CardTitle>
                        <CardDescription>
                          {`Created ${whenText(link.createdAt)} · ${String(link.scans)} scans · ${String(link.answered)} answered`}
                        </CardDescription>
                      </div>
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badge.tone}`}
                        >
                          {badge.text}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setMinted(null);
                            setPrinting(printing?.id === link.id ? null : link);
                          }}
                        >
                          <QrCode className="h-3.5 w-3.5" aria-hidden />
                          {printing?.id === link.id ? "Hide QR" : "Show QR"}
                        </Button>
                        {standingState(link) === "live" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(link.id)}
                          >
                            <Ban className="h-3.5 w-3.5" aria-hidden />
                            Withdraw
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-[auto_1fr] dark:text-slate-400">
                      <dt className="font-medium">Stops working</dt>
                      <dd>{whenText(link.expiresAt)}</dd>
                      <dt className="font-medium">Form</dt>
                      <dd className="font-mono break-all">
                        {link.questionnaireCanonical ?? "not declared"}
                      </dd>
                    </dl>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : null}

        {revoke.error ? (
          <Alert tone="error" title="Could not withdraw the code">
            {revoke.error instanceof Error
              ? revoke.error.message
              : String(revoke.error)}
          </Alert>
        ) : null}
      </section>
    </div>
  );
}
