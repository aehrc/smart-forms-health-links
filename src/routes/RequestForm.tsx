import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Inbox, Loader2, Send } from "lucide-react";
import { useState } from "react";
import {
  Link as RouterLink,
  useParams,
  useSearchParams,
} from "react-router-dom";

import Connect from "./Connect";

import PatientPicker from "@/components/PatientPicker";
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
import { fetchPatient, patientDisplay } from "@/fhir/ehrServer";
import {
  fetchQuestionnaireById,
  isRenderableQuestionnaire,
} from "@/fhir/formsServer";
import { useConfig } from "@/lib/configContextValue";
import { FHIR_PROXY_BASE, useRequesterGate } from "@/lib/session";
import { createRequestLink, type CreatedRequest } from "@/link/createLink";

/**
 * Create a "please fill this in" link for a form.
 *
 * The page asks the BFF to mint (`POST /api/invitations`) and shows what comes back. Three
 * things happen server-side that used to happen here, and all three are the point of the
 * feature: the request Task is published to the launched server with the session's authority
 * (FR-010), the encrypted payload is hosted by this app rather than by a third-party blob server
 * (FR-013), and the link resolves to a manifest that mints a fresh, short-lived grant on every
 * fetch (FR-014). Nothing about that is visible from here except that it either worked or it
 * did not.
 *
 * The subject is pre-filled from the launch context. An EHR launch already names the patient the
 * clinician is looking at, so asking them to pick that patient again would be asking them to
 * repeat what they just told the system. The reference is resolved through the proxy for a
 * display name, because a filler cannot resolve a reference into a server it has no access to -
 * the name is the only part of "who is this for" that survives the trip. It stays editable: a
 * request is not always for the patient on screen.
 * @author John Grimes
 */

/**
 * Create-a-request page.
 * @returns the form, a launch prompt, or a loading line
 */
export default function RequestForm() {
  const { questionnaireId } = useParams<{ questionnaireId: string }>();
  const [params] = useSearchParams();
  const config = useConfig();

  const [editedSubject, setEditedSubject] = useState<string | null>(null);
  const [editedDisplay, setEditedDisplay] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedRequest | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const {
    data: questionnaire,
    isPending,
    error: loadError,
  } = useQuery({
    queryKey: ["questionnaire", questionnaireId],
    queryFn: ({ signal }) =>
      fetchQuestionnaireById(FHIR_PROXY_BASE, questionnaireId!, signal),
    enabled: !!questionnaireId,
  });

  const gate = useRequesterGate(loadError ?? error);
  const launchPatientId =
    gate.kind === "ready" ? gate.session.patientId : undefined;

  /*
   * The launch context patient, resolved for a name. A launch that carried no patient - every
   * standalone launch, and an EHR launch without `launch/patient` - simply leaves the fields
   * empty for the picker to fill.
   */
  const { data: launchPatient } = useQuery({
    queryKey: ["launch-patient", launchPatientId],
    queryFn: ({ signal }) =>
      fetchPatient(FHIR_PROXY_BASE, launchPatientId!, signal),
    enabled: launchPatientId !== undefined && launchPatientId !== null,
  });

  /*
   * Pre-fill, then get out of the way. The picker navigates back here with its choice in the query
   * string, and an EHR launch names a patient of its own; both are defaults, so they are resolved
   * during render in order of specificity rather than written back into state. Anything the user
   * typed or chose is held separately and always wins, and the launch context resolving late
   * cannot overwrite it.
   */
  const pickedSubject = params.get("subject");
  const pickedDisplay = params.get("subjectDisplay");
  const launchSubject =
    launchPatient?.id === undefined ? "" : `Patient/${launchPatient.id}`;
  const launchDisplay =
    launchPatient?.id === undefined ? "" : patientDisplay(launchPatient);
  const subject = editedSubject ?? pickedSubject ?? launchSubject;
  const subjectDisplay = editedDisplay ?? pickedDisplay ?? launchDisplay;

  /** Mint the link, or explain why nothing was created. */
  async function handleCreate() {
    if (questionnaireId === undefined) {
      return;
    }

    setError(null);
    setIsCreating(true);
    try {
      setCreated(
        await createRequestLink(questionnaireId, config, {
          subjectReference: subject.trim() === "" ? undefined : subject.trim(),
          subjectDisplay:
            subjectDisplay.trim() === "" ? undefined : subjectDisplay.trim(),
        }),
      );
    } catch (error_) {
      setCreated(null);
      /*
       * Anything that is not already an Error is wrapped rather than stringified: `String()` on an
       * arbitrary thrown object yields "[object Object]", which tells the reader nothing, and the
       * original value is still reachable through `cause`.
       */
      setError(
        error_ instanceof Error
          ? error_
          : new Error("The request could not be created.", { cause: error_ }),
      );
    } finally {
      setIsCreating(false);
    }
  }

  if (gate.kind === "loading" || isPending) {
    return <Loading>Loading form…</Loading>;
  }

  if (gate.kind === "launch-required") {
    return <Connect reason={gate.reason} />;
  }

  if (loadError) {
    return (
      <Alert tone="error" title="Could not load form">
        {loadError instanceof Error ? loadError.message : String(loadError)}
      </Alert>
    );
  }

  if (!isRenderableQuestionnaire(questionnaire)) {
    return (
      <Alert tone="warning" title="This form has no items">
        {questionnaire.title ?? questionnaireId} contains no questions, so there
        is nothing to request.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <RouterLink
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All forms
      </RouterLink>

      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Request:{" "}
          {questionnaire.title ?? questionnaire.name ?? questionnaire.id}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Creates an encrypted SMART Health Link containing this whole form.
          Answers come back to {gate.session.issuerLabel}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who is this for?</CardTitle>
          <CardDescription>
            {launchPatient
              ? "Pre-filled from the patient you launched with. Change it if this request is for someone else."
              : "Both optional. The reference correlates the answers on your own server; the name is the part a filler can actually read, since it cannot resolve a reference into a server it has no access to."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Search the server you are signed in to
            </p>
            <PatientPicker
              serverUrl={FHIR_PROXY_BASE}
              selectedReference={
                subject.trim() === "" ? undefined : subject.trim()
              }
              onChoose={(chosen) => {
                setEditedSubject(chosen.reference);
                setEditedDisplay(chosen.display);
              }}
              label="Search patients to address this request to"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Or enter it by hand
            </p>
            <Input
              value={subject}
              onChange={(event) => setEditedSubject(event.target.value)}
              placeholder="Patient/123"
              aria-label="Subject reference"
            />
            <Input
              value={subjectDisplay}
              onChange={(event) => setEditedDisplay(event.target.value)}
              placeholder="Jane Citizen"
              aria-label="Subject name"
            />
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Or{" "}
            <RouterLink
              to={`/patients?returnTo=${encodeURIComponent(`/request/${questionnaireId ?? ""}`)}`}
              className="underline"
            >
              browse the full patient list
            </RouterLink>
            , which also shows what each one has already answered.
          </p>

          <Button
            onClick={() => {
              void handleCreate();
            }}
            disabled={isCreating}
          >
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {isCreating ? "Publishing and encrypting…" : "Create request link"}
          </Button>
        </CardContent>
      </Card>

      <Alert title="How answers come back">
        <p>
          <strong>Straight into {gate.session.issuerLabel}</strong> - the link
          carries a short-lived credential that lets whoever fills the form
          write their answers back to this request, and nowhere else.
        </p>
        <p className="mt-2">
          If that credential has expired by the time they finish, they can
          instead hand the answers back as their own link for you to{" "}
          <RouterLink to="/scan" className="underline">
            scan
          </RouterLink>
          , and nothing is written until you accept it.
        </p>
        {(gate.session.userDisplay ?? config.senderName) ? null : (
          <p className="mt-2">
            This launch disclosed no user and no{" "}
            <span className="font-mono text-xs">senderName</span> is configured,
            so the request cannot say who it is from. That is a reason for
            someone to decline it.
          </p>
        )}
      </Alert>

      {error ? (
        <Alert tone="error" title="Could not create the request">
          {error.message}
        </Alert>
      ) : null}

      {created ? (
        <>
          <Alert title="Published to the server">
            <p>
              Reference{" "}
              <span className="font-mono text-xs">
                {created.requestIdentifier}
              </span>
              . The request is now a task on {gate.session.issuerLabel}; track
              it from{" "}
              <RouterLink
                to="/requests"
                className="inline-flex items-center gap-1 underline"
              >
                <Inbox className="h-3 w-3" aria-hidden />
                Sent requests
              </RouterLink>
              .
            </p>
          </Alert>
          <ShareLinkPanel link={created.link} kind="request" />
        </>
      ) : null}
    </div>
  );
}
