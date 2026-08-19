import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CloudOff,
  Download,
  Inbox,
  Loader2,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react';
import { useConfig } from '@/lib/ConfigContext';
import { canTrackRequests } from '@/lib/config';
import {
  deleteRequest,
  exportRequests,
  importRequests,
  isExpired,
  listRequests,
  updateRequest,
  type OutstandingRequest
} from '@/lib/requestStore';
import { mergeSentRequests, whyNotCollectable, type SentRequest } from '@/lib/sentRequests';
import { searchPublishedRequests } from '@/fhir/ehrServer';
import { collectAnswers, type CollectOutcome } from '@/link/collectReply';
import ReviewResponse from '@/components/ReviewResponse';
import ShareLinkPanel from '@/components/ShareLinkPanel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Requests this app has sent, and what has come back.
 *
 * A request is asynchronous — minted now, answered whenever the patient gets round to it — so there
 * has to be somewhere to come back to. This is it.
 *
 * By default answers return as a link the filler mints, so there is nothing here to poll: a row
 * simply waits until someone opens that link, and `/view` stamps the match onto it. Rows gain a Check
 * button when the request offered a slot — encrypted (`enableEncryptedReply`) or plain
 * (`enableOneShotWrite`) — which is the case this page's polling machinery exists for.
 *
 * The list is the union of two sources with different reach, described in `src/lib/sentRequests.ts`:
 * the EHR knows every published request, and this browser knows the reply keys. A request that is
 * visible but not collectable says so rather than offering an action that could not work.
 */

type RowState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'pending' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; outcome: Extract<CollectOutcome, { status: 'ready' }> };

export default function Requests() {
  const config = useConfig();

  const [localRequests, setLocalRequests] = useState<OutstandingRequest[]>(() => listRequests());
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const tracking = canTrackRequests(config);

  const { data: publishedPage, error: publishedError } = useQuery({
    queryKey: ['published-requests', config.responseServerUrl],
    queryFn: ({ signal }) => searchPublishedRequests(config.responseServerUrl!, 50, signal),
    enabled: tracking,
    retry: false
  });

  const requests = mergeSentRequests(localRequests, publishedPage?.resources ?? []);

  const setState = useCallback((id: string, state: RowState) => {
    setStates((current) => ({ ...current, [id]: state }));
  }, []);

  const check = useCallback(
    async (request: OutstandingRequest) => {
      setState(request.id, { kind: 'checking' });
      try {
        const outcome = await collectAnswers(request, config.formsServerUrl);
        setState(
          request.id,
          outcome.status === 'ready' ? { kind: 'ready', outcome } : { kind: outcome.status }
        );
      } catch (cause) {
        setState(request.id, {
          kind: 'error',
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    },
    [config.formsServerUrl, setState]
  );

  /*
   * Check everything still outstanding on arrival. Polling is the only signal available — a reply slot is
   * a file, so there is nothing to subscribe to — but doing it once on mount rather than on a timer keeps
   * it an explicit action the reviewer controls.
   */
  useEffect(() => {
    for (const request of listRequests()) {
      if ((request.reply || request.write) && !request.collectedAt && !isExpired(request)) {
        void check(request);
      }
    }
  }, [check]);

  function refreshLocal() {
    setLocalRequests(listRequests());
  }

  function handleDelete(request: SentRequest) {
    if (!request.local) {
      return;
    }

    const answered = states[request.id]?.kind === 'ready';
    const warning = !request.local.reply && request.local.write
      ? `Forget "${request.label}"? Its write slot stays where it is and any answers written there remain readable — you just lose the address for them.`
      : !request.local.reply
      ? `Forget "${request.label}"? Answers returned as a link can still be opened, but they will no longer be matched to this request.`
      : answered
        ? `Forget "${request.label}"? A reply has already arrived, and discarding the key makes it permanently unreadable.`
        : `Forget "${request.label}"? This discards the key that decrypts its reply, so any answer sent later cannot be read by anyone.`;

    if (!window.confirm(warning)) {
      return;
    }

    deleteRequest(request.id);
    refreshLocal();
  }

  function handleExport() {
    const blob = new Blob([exportRequests()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'smart-forms-requests.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(file: File) {
    setImportError(null);
    setNotice(null);
    try {
      const outcome = importRequests(await file.text());
      refreshLocal();
      setNotice(
        `Imported ${outcome.imported} request(s)` +
          (outcome.skipped > 0 ? `, skipped ${outcome.skipped} unreadable record(s).` : '.')
      );
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const reviewing = requests
    .map((request) => ({ request, state: states[request.id] }))
    .find((row): row is { request: SentRequest; state: Extract<RowState, { kind: 'ready' }> } =>
      row.state?.kind === 'ready'
    );

  const serverOnlyCount = requests.filter((request) => request.origin === 'server-only').length;

  return (
    <div className="space-y-4">
      <RouterLink
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All forms
      </RouterLink>

      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Sent requests</h1>
          <p className="text-sm text-slate-500">
            {tracking ? (
              <>
                Published to <span className="font-mono text-xs">{config.responseServerUrl}</span>, plus
                anything held only in this browser.
              </>
            ) : (
              'Held in this browser only — request publishing is off.'
            )}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={localRequests.length === 0}>
            <Download className="h-4 w-4" aria-hidden />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden />
            Import
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleImport(file);
              }
              event.target.value = '';
            }}
          />
        </div>
      </div>

      {localRequests.some((request) => request.reply) ? (
        <Alert tone="warning" title="Reply keys never leave this browser">
          A reply can only be read with the key generated when its request was made, and that key is
          stored here and nowhere else — not in the link, not on any server.{' '}
          <strong>Clearing site data destroys pending replies.</strong> An exported file decrypts every
          reply it covers, so treat it exactly as sensitively as the answers themselves.
        </Alert>
      ) : (
        <Alert title="Answers come back as a link">
          These requests carry no reply slot, so there is nothing here to poll. When someone completes
          one, they hand back their own SMART Health Link — open it from{' '}
          <RouterLink to="/scan" className="underline">
            Scan
          </RouterLink>{' '}
          and the row below will be matched to it automatically.
        </Alert>
      )}

      {publishedError ? (
        <Alert tone="warning" title="Could not list published requests">
          {publishedError instanceof Error ? publishedError.message : String(publishedError)}
          <p className="mt-1">
            Requests held in this browser are still shown below; only the server-wide list is missing.
          </p>
        </Alert>
      ) : null}

      {serverOnlyCount > 0 ? (
        <Alert title={`${serverOnlyCount} request(s) sent from elsewhere`}>
          These were published by another browser, so their reply keys are there rather than here. Export
          from that browser and import here to collect their answers.
        </Alert>
      ) : null}

      {notice ? <Alert title="Import complete">{notice}</Alert> : null}
      {importError ? (
        <Alert tone="error" title="Could not import">
          {importError}
        </Alert>
      ) : null}

      {requests.length === 0 ? (
        <Alert title="Nothing sent yet">
          Create a request from a form and it will appear here, with somewhere to collect the reply.
        </Alert>
      ) : null}

      <div className="space-y-3">
        {requests.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            state={states[request.id] ?? { kind: 'idle' }}
            onCheck={() => request.local && void check(request.local)}
            onDelete={() => handleDelete(request)}
          />
        ))}
      </div>

      {reviewing ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reply to “{reviewing.request.label}”</CardTitle>
            <CardDescription>
              {reviewing.request.local?.reply
                ? 'Decrypted in this browser. Nothing has been written yet — review the answers, then accept.'
                : 'Collected from the slot this request set aside. Nothing has been written to your record yet — review the answers, then accept.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReviewResponse
              questionnaire={reviewing.state.outcome.questionnaire}
              response={reviewing.state.outcome.payload.response}
              task={reviewing.state.outcome.payload.task}
              provenance={reviewing.state.outcome.payload.provenance}
              /*
               * Answers written into a slot carry a `subject` display and no reference — a filler's
               * own patient id resolves nowhere, and on the slot server it would fail the write
               * outright. Handing the review the request's own record gives the reviewer the patient
               * it was addressed to as a one-click reconciliation instead of a free-text search.
               */
              matchedRequest={reviewing.request.local}
              label={reviewing.request.label}
              onSaved={() => {
                updateRequest(reviewing.request.id, { collectedAt: new Date().toISOString() });
                refreshLocal();
              }}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

interface RequestRowProps {
  request: SentRequest;
  state: RowState;
  onCheck: () => void;
  onDelete: () => void;
}

function RequestRow({ request, state, onCheck, onDelete }: RequestRowProps) {
  const [showLink, setShowLink] = useState(false);
  const expired = request.expiresAt !== undefined && request.expiresAt * 1000 < Date.now();
  const blocker = whyNotCollectable(request);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{request.label}</CardTitle>
            <CardDescription>
              {request.createdAt ? `Sent ${new Date(request.createdAt).toLocaleString()}` : 'Sent'}
              {request.subjectDisplay ? ` · for ${request.subjectDisplay}` : null}
              {request.requesterDisplay ? ` · by ${request.requesterDisplay}` : null}
              {expired ? ' · expired' : null}
            </CardDescription>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <OriginBadge origin={request.origin} />
            <StatusBadge
              state={state}
              collectedAt={request.local?.collectedAt}
              expired={expired}
              collectable={request.collectable}
              hasReplySlot={request.local?.reply !== undefined || request.local?.write !== undefined}
            />
            {request.collectable && !request.local?.collectedAt ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onCheck}
                disabled={state.kind === 'checking'}>
                {state.kind === 'checking' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                Check
              </Button>
            ) : null}
            {request.local ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setShowLink((shown) => !shown)}>
                  {showLink ? 'Hide link' : 'Show link'}
                </Button>
                <Button variant="outline" size="sm" onClick={onDelete} title="Forget this request">
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">Reference</dt>
          <dd className="font-mono break-all">{request.id}</dd>
          {request.local?.reply ? (
            <>
              <dt className="font-medium">Reply slot</dt>
              <dd className="font-mono break-all">{request.local.reply.url}</dd>
            </>
          ) : null}
          {request.local?.write ? (
            <>
              <dt className="font-medium">Write slot</dt>
              <dd className="font-mono break-all">{request.local.write.url}</dd>
            </>
          ) : null}
          {request.serverTask?.id ? (
            <>
              <dt className="font-medium">Published Task</dt>
              <dd className="font-mono break-all">Task/{request.serverTask.id}</dd>
            </>
          ) : null}
        </dl>

        {blocker ? <p className="text-xs text-slate-500">{blocker}</p> : null}

        {request.local?.serverReturnOffered ? (
          <Alert tone="warning" title="This request also accepts a direct write">
            The plain-FHIR return channel was enabled for it, so a filler can post answers straight to{' '}
            <span className="font-mono text-xs break-all">{request.local.serverTaskUrl}</span>&rsquo;s
            server without passing through review here. Check that server for responses too.
          </Alert>
        ) : null}

        {state.kind === 'error' ? (
          <Alert tone="error" title="Could not collect the reply">
            {state.message}
          </Alert>
        ) : null}

        {state.kind === 'gone' ? (
          <Alert tone="warning" title="The reply slot is no longer there">
            It has been deleted or has expired. If the form still needs answering, send a new request.
          </Alert>
        ) : null}

        {showLink && request.local ? (
          <ShareLinkPanel link={request.local.link} kind="request" />
        ) : null}
      </CardContent>
    </Card>
  );
}

function OriginBadge({ origin }: { origin: SentRequest['origin'] }) {
  if (origin === 'tracked') {
    return null;
  }

  const label = origin === 'server-only' ? 'Another browser' : 'Not published';
  const title =
    origin === 'server-only'
      ? 'Published to the server by a different browser, which holds its reply key'
      : 'Held only in this browser — no other browser can see it';

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
      title={title}>
      <CloudOff className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

function StatusBadge(props: {
  state: RowState;
  collectedAt?: string;
  expired: boolean;
  collectable: boolean;
  /** Whether this request offered a reply slot at all — if not, there is nothing here to poll. */
  hasReplySlot: boolean;
}) {
  const { state, collectedAt, expired, collectable, hasReplySlot } = props;

  const label = collectedAt
    ? 'Accepted'
    : state.kind === 'ready'
      ? 'Reply ready'
      : state.kind === 'checking'
        ? 'Checking…'
        : state.kind === 'pending'
          ? expired
            ? 'No reply, expired'
            : 'Awaiting reply'
          : state.kind === 'gone'
            ? 'Slot gone'
            : state.kind === 'error'
              ? 'Check failed'
              : collectable
                ? 'Not checked'
                : hasReplySlot
                  ? 'Not collectable here'
                  : expired
                    ? 'Expired'
                    : 'Awaiting answers';

  const tone = collectedAt
    ? 'bg-slate-100 text-slate-600'
    : state.kind === 'ready'
      ? 'bg-green-100 text-green-800'
      : state.kind === 'error' || state.kind === 'gone'
        ? 'bg-amber-100 text-amber-900'
        : 'bg-slate-100 text-slate-600';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {state.kind === 'ready' ? (
        <Inbox className="h-3 w-3" aria-hidden />
      ) : state.kind === 'error' || state.kind === 'gone' ? (
        <AlertTriangle className="h-3 w-3" aria-hidden />
      ) : null}
      {label}
    </span>
  );
}
