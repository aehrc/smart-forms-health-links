import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Inbox, Loader2, Send } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Link as RouterLink,
  useParams,
  useSearchParams,
} from "react-router-dom";

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
import {
  fetchQuestionnaireById,
  isRenderableQuestionnaire,
} from "@/fhir/formsServer";
import { useConfig } from "@/lib/ConfigContext";
import { saveRequest } from "@/lib/requestStore";
import { FHIR_PROXY_BASE } from "@/lib/session";
import { canCreateHealthLinks, createRequestLink } from "@/link/createLink";
import { questionnaireCanonicalOf, taskCorrelationId } from "@/link/exchange";

/**
 * Create a "please fill this in" SMART Health Link for a form.
 *
 * The Questionnaire is embedded in the encrypted payload, so whoever scans this needs no access to
 * the launched server. The link itself stays a few hundred bytes because it carries only a URL and
 * a decryption key.
 *
 * TODO(phase-4): T031 reworks this surface onto `POST /api/invitations`: the subject is pre-filled
 * from the session's launch context, the Task is published server-side with the session's
 * authority (FR-010), and the payload is hosted by this app rather than by a third-party blob
 * server. Channel B and channel C went with the configuration keys that enabled them, so what is
 * left below is the subject picker and an explanation that minting is not available yet.
 */
export default function RequestForm() {
  const { questionnaireId } = useParams<{ questionnaireId: string }>();
  const [params] = useSearchParams();
  const config = useConfig();

  const [subject, setSubject] = useState("");
  const [subjectDisplay, setSubjectDisplay] = useState("");

  /*
   * The patient picker navigates back here with the chosen patient in the query string. Applied via an
   * effect rather than as initial state so returning from the picker updates the fields on a route that
   * is already mounted.
   */
  const pickedSubject = params.get("subject");
  const pickedDisplay = params.get("subjectDisplay");
  useEffect(() => {
    if (pickedSubject) {
      setSubject(pickedSubject);
    }
    if (pickedDisplay) {
      setSubjectDisplay(pickedDisplay);
    }
  }, [pickedSubject, pickedDisplay]);
  const [link, setLink] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | undefined>();
  /** Whether the request just created actually minted a reply slot, as opposed to config saying it could. */
  const [hadReplySlot, setHadReplySlot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canHost = canCreateHealthLinks();

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

  async function handleCreate() {
    if (!questionnaire) {
      return;
    }

    setError(null);
    setIsCreating(true);
    try {
      const created = await createRequestLink(questionnaire, config, {
        subjectReference: subject.trim() === "" ? undefined : subject.trim(),
        subjectDisplay:
          subjectDisplay.trim() === "" ? undefined : subjectDisplay.trim(),
      });

      const id = taskCorrelationId(created.task);

      /*
       * Persist before showing the link, and let a storage failure surface as a failure to create.
       * The private key that decrypts the reply exists only here — handing over a QR whose answers
       * could never be read would be worse than not creating the request at all.
       */
      if (id) {
        saveRequest({
          id,
          label:
            questionnaire.title ??
            questionnaire.name ??
            questionnaire.id ??
            "Questionnaire",
          questionnaireCanonical: questionnaireCanonicalOf(questionnaire),
          createdAt: new Date().toISOString(),
          expiresAt: created.expiresAt,
          link: created.link,
          subjectDisplay:
            subjectDisplay.trim() === "" ? undefined : subjectDisplay.trim(),
          // Kept so scanned answers naming a foreign patient can be reconciled in one click.
          subjectReference: subject.trim() === "" ? undefined : subject.trim(),
          reply: created.reply
            ? { url: created.reply.url, privateJwk: created.reply.privateJwk }
            : undefined,
          serverTaskUrl: created.serverTaskUrl,
          serverReturnOffered: created.serverReturnOffered,
        });
      }

      setLink(created.link);
      setCorrelationId(id);
      setHadReplySlot(created.reply !== undefined);
    } catch (error_) {
      setLink(null);
      setError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setIsCreating(false);
    }
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading form…
      </p>
    );
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
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who is this for?</CardTitle>
          <CardDescription>
            Both optional. The reference correlates the answers on your own
            server; the name is the part a filler can actually read, since it
            cannot resolve a reference into a server it has no access to.
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
                setSubject(chosen.reference);
                setSubjectDisplay(chosen.display);
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
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Patient/123"
              aria-label="Subject reference"
            />
            <Input
              value={subjectDisplay}
              onChange={(event) => setSubjectDisplay(event.target.value)}
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

          <Button onClick={handleCreate} disabled={isCreating || !canHost}>
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {isCreating ? "Encrypting and uploading…" : "Create request link"}
          </Button>
        </CardContent>
      </Card>

      <Alert title="One return channel">
        <p>
          <strong>Answers come back as a link</strong> - whoever fills this in
          produces their own SMART Health Link and you scan or paste it into{" "}
          <RouterLink to="/scan" className="underline">
            Scan
          </RouterLink>
          . You review the answers, and nothing is written until you accept.
        </p>
        {config.senderName ? null : (
          <p className="mt-2">
            No <span className="font-mono text-xs">senderName</span> is
            configured, so this request falls back to whatever the launch
            disclosed about who is signed in. A request that cannot say who it
            is from is a reason for someone to decline it.
          </p>
        )}
      </Alert>

      {canHost ? null : (
        <Alert tone="warning" title="Requests cannot be created yet">
          {/* TODO(phase-4): T031 mints through `POST /api/invitations`. */}
          An invitation&rsquo;s encrypted payload has to be hosted somewhere.
          Hosting moves to this app&rsquo;s own server, which is not implemented
          yet, so nothing can be minted in this build.
        </Alert>
      )}

      {error ? (
        <Alert tone="error" title="Could not create the request">
          {error}
        </Alert>
      ) : null}

      {link ? (
        <>
          {correlationId ? (
            <Alert title="Saved to Sent requests">
              <p>
                Reference{" "}
                <span className="font-mono text-xs">{correlationId}</span>.{" "}
                {hadReplySlot
                  ? "The key that decrypts the reply is stored in this browser only — collect it from "
                  : "When the answers come back, this reference is what matches them to this request. Track it from "}
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
          ) : null}
          <ShareLinkPanel link={link} kind="request" />
        </>
      ) : null}
    </div>
  );
}
