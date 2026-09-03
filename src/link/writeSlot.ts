import { writeSlotId, type WriteDescriptor } from "./replyDescriptor";

import type { QuestionnaireResponse } from "fhir/r4";

/**
 * The write slot: a pre-allocated `QuestionnaireResponse` a filler may fill in exactly once.
 *
 * Deliberately the smallest contract that closes the loop, and one a filler can implement with a
 * `fetch` and no library at all:
 *
 *   mint    POST {writeSlotServerUrl}/QuestionnaireResponse   status: in-progress   -> url + ETag
 *   write   PUT  {writeUrl}   If-Match: {etag}   Authorization: Bearer {token}
 *   poll    GET  {writeUrl}   -> in-progress | completed
 *
 * ## Why the slot is a resource and not an endpoint
 *
 * Channel B named a *server* and carried no capability, so the endpoint had to accept a write from
 * anyone holding a link, and there was no way to say "once". Naming one pre-allocated resource fixes
 * both: the capability is bounded to a single address, and `If-Match` against the version the slot is
 * already at means the second write collides with the first and is refused — `409` on HAPI, `412`
 * elsewhere. That is a property of any conformant FHIR server, so the once-only guarantee needs no
 * authorisation tier and survives a host that ignores {@link WriteDescriptor.writeToken} entirely.
 *
 * ## Why the slot is not on the record server
 *
 * A slot is transport, and it holds an unreviewed assertion from a party whose only credential is
 * that they had a link. It is minted on `writeSlotServerUrl` — `blobServerUrl` by default, the same
 * host that already holds the encrypted payload — so the requester collects it, shows it to a human,
 * and only then does `submitResponse` write to the record. That is what makes this channel a
 * replacement for B rather than a repeat of it.
 *
 * ## What it trades away against channel C
 *
 * The slot holds plaintext FHIR, so its host sees the answers. Channel C exists precisely so that
 * cannot happen, and is still the right choice where the host is not trusted with the content. What
 * is bought here is reach: a filler needs ECDH-ES, A256GCM and a hand-written Concat-KDF to answer
 * channel C, and needs `PUT` to answer this one.
 *
 * {@link putResponseToSlot} and {@link pollWriteSlot} take an absolute URL rather than a configured
 * server, because a filler holds a URL for a host it has no configuration for at all.
 */

const FHIR_JSON = "application/fhir+json";

/**
 * Marks a slot as one of ours, so slots can be told apart from real responses on a shared server.
 *
 * A tag rather than a naming convention for the same reason `SHL_REQUEST_TAG` is one: it is
 * searchable, which is what lets an operator find and clean up slots nobody ever answered.
 */
export const SHL_WRITE_SLOT_TAG = {
  system: "http://smartforms.csiro.au/CodeSystem/shl-request",
  code: "shl-write-slot",
  display: "Slot awaiting answers returned over a SMART Health Link",
} as const;

/**
 * Mint the capability half of the descriptor.
 *
 * 32 bytes of CSPRNG output, base64url. Be clear-eyed about what this is worth: a plain FHIR server
 * has no notion of bearer tokens and will ignore it, so on the default deployment it is advisory and
 * the once-only guarantee rests entirely on `If-Match`. It is minted and carried anyway because it
 * is the field a gating host needs, and having it in the wire format means such a host needs no
 * format change — the same posture `ReplyDescriptor.replyToken` already takes.
 */
export function mintWriteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export interface CreateWriteSlotOptions {
  /** Canonical of the form being asked for, so an unanswered slot still says what it was for. */
  questionnaireCanonical?: string;
  /** The request's business identifier, `urn:uuid:…`. Also what makes each slot unique on the wire. */
  requestId?: string;
}

export interface MintedWriteSlot {
  writeUrl: string;
  writeEtag: string;
  writeToken: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

interface OperationOutcome {
  resourceType?: string;
  issue?: { diagnostics?: string }[];
}

/**
 * The human-readable reason out of a FHIR error response, when there is one.
 * @param response
 */
async function describeFailure(response: Response): Promise<string> {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  try {
    const body = (await response.json()) as OperationOutcome;
    const diagnostics = (body.issue ?? [])
      .map((issue) => issue.diagnostics)
      .filter((text): text is string => !!text);

    if (diagnostics.length > 0) {
      return `${status}: ${diagnostics.join("; ")}`;
    }
  } catch {
    // Not every error response carries an OperationOutcome.
  }

  return status;
}

/**
 * Pre-allocate a slot and return the capability that addresses it.
 *
 * The placeholder write is what reserves the URL — the invitation cannot name a resource that does
 * not exist yet, and the server assigns the id.
 *
 * Two details that look like paranoia and are not:
 *
 *  - **The version comes from the created resource, never assumed to be `1`.** A server is free to
 *    start elsewhere, and an `If-Match` naming a version the slot is not at fails *closed*: the
 *    filler cannot write at all, and the request silently never gets answered.
 *  - **The URL is rebuilt from the base and the id, not taken from `Location`.** `blobStore.ts`
 *    documents why — the forms server reports a scheme and path that do not resolve.
 * @param serverUrl
 * @param options
 */
export async function createWriteSlot(
  serverUrl: string,
  options: CreateWriteSlotOptions = {},
): Promise<MintedWriteSlot> {
  const base = trimTrailingSlash(serverUrl);

  /*
   * `identifier` carries the request id, which does double duty: it correlates a collected response
   * to the request that asked for it, and it makes every slot byte-distinct. A fixed placeholder
   * would make the second slot ever minted a duplicate create, which a deduplicating server refuses
   * outright (HAPI-2840) — the same trap `replySlotPlaceholder` documents.
   *
   * No `subject`. The slot's server is transport and need not hold the patient at all, and a
   * reference that does not resolve there would fail the create with HAPI-1094.
   */
  const slot: QuestionnaireResponse = {
    resourceType: "QuestionnaireResponse",
    status: "in-progress",
    meta: { tag: [{ ...SHL_WRITE_SLOT_TAG }] },
    ...(options.questionnaireCanonical
      ? { questionnaire: options.questionnaireCanonical }
      : {}),
    ...(options.requestId
      ? {
          identifier: {
            system: "urn:ietf:rfc:3986",
            value: `urn:uuid:${options.requestId}`,
          },
        }
      : {}),
  };

  const response = await fetch(`${base}/QuestionnaireResponse`, {
    method: "POST",
    headers: { "Content-Type": FHIR_JSON, Accept: FHIR_JSON },
    body: JSON.stringify(slot),
  });

  if (!response.ok) {
    throw new Error(
      `Could not create a write slot on ${base} — ${await describeFailure(response)}`,
    );
  }

  const created = (await response.json()) as {
    resourceType?: string;
    id?: string;
    meta?: { versionId?: string };
  };
  if (created.resourceType === "OperationOutcome" || !created.id) {
    throw new Error(`${base} rejected the write slot.`);
  }

  /*
   * `meta.versionId` from the body rather than the `ETag` header, because in a browser a response
   * header is invisible unless the server lists it in `Access-Control-Expose-Headers`, and most do
   * not. The header is the fallback for a server that returns no body version.
   */
  const versionId =
    created.meta?.versionId ?? readEtagVersion(response.headers.get("ETag"));
  if (!versionId) {
    throw new Error(
      `${base} created a write slot but reported no version for it, so the invitation cannot make ` +
        "the write conditional — and an unconditional write is not a single write.",
    );
  }

  return {
    writeUrl: `${base}/QuestionnaireResponse/${created.id}`,
    writeEtag: `W/"${versionId}"`,
    writeToken: mintWriteToken(),
  };
}

/**
 * The version out of a weak or strong ETag, e.g. `W/"3"` -> `3`.
 * @param etag
 */
function readEtagVersion(etag: string | null): string | undefined {
  const match = etag?.match(/"([^"]+)"/);
  return match?.[1];
}

/**
 * What happened to a one-shot write.
 *
 * A union rather than a throw for the outcomes that are *expected*, because they need different
 * words in front of a person: `taken` is not a failure the filler can retry their way out of, and
 * telling them to try again would be a lie.
 */
export type WriteSlotOutcome =
  | { status: "written" }
  /** The slot was already answered — by an earlier send of ours, or by someone else entirely. */
  | { status: "taken"; detail: string }
  /** The host gates writes and refused this token. */
  | { status: "refused"; detail: string }
  /** The slot no longer exists: deleted, or expired and cleaned up. */
  | { status: "gone" };

/**
 * Write the answers into a slot, once.
 *
 * The `If-Match` is the whole mechanism. Without it this is an unconditional overwrite and the
 * channel's central claim is false, so a descriptor that carries no ETag is honoured — it is still a
 * valid place to send answers — but it is not a *single* write, and only the requester can decide
 * whether to mint one like that.
 *
 * `resource.id` must match the id in the URL or the server rejects the update. This is the one path
 * in the app where an id is deliberately preserved rather than stripped; {@link writeSlotId} exists
 * so the caller does not have to parse the URL itself.
 * @param descriptor
 * @param response
 */
export async function putResponseToSlot(
  descriptor: WriteDescriptor,
  response: QuestionnaireResponse,
): Promise<WriteSlotOutcome> {
  const id = writeSlotId(descriptor.writeUrl);
  if (!id) {
    throw new Error(
      `"${descriptor.writeUrl}" does not name a resource to write to.`,
    );
  }

  const result = await fetch(descriptor.writeUrl, {
    method: "PUT",
    headers: {
      "Content-Type": FHIR_JSON,
      Accept: FHIR_JSON,
      ...(descriptor.writeEtag ? { "If-Match": descriptor.writeEtag } : {}),
      ...(descriptor.writeToken
        ? { Authorization: `Bearer ${descriptor.writeToken}` }
        : {}),
    },
    body: JSON.stringify({ ...response, id }),
  });

  if (result.ok) {
    return { status: "written" };
  }

  if (result.status === 409 || result.status === 412) {
    return { status: "taken", detail: await describeFailure(result) };
  }

  if (result.status === 401 || result.status === 403) {
    return { status: "refused", detail: await describeFailure(result) };
  }

  if (result.status === 404 || result.status === 410) {
    return { status: "gone" };
  }

  throw new Error(
    `Could not write the answers to ${descriptor.writeUrl} — ${await describeFailure(result)}. ` +
      "The answers have not been sent.",
  );
}

export type WriteSlotPoll =
  | { status: "pending" }
  | { status: "ready"; response: QuestionnaireResponse }
  | { status: "gone" };

/**
 * Check a slot for answers.
 *
 * "Answered" is decided **structurally**, from the response's own `status`, rather than by comparing
 * against whatever the slot was minted with. A host is free to represent an untouched slot however
 * it likes, and a requester that recognised only its own placeholder would miss a reply that arrived
 * through any other route.
 *
 * `404`/`410` is `gone`, not an error: a slot that expired and was cleaned up is a normal end state
 * for a request nobody answered, and should read as one.
 * @param writeUrl
 * @param signal
 */
export async function pollWriteSlot(
  writeUrl: string,
  signal?: AbortSignal,
): Promise<WriteSlotPoll> {
  const result = await fetch(writeUrl, {
    headers: { Accept: FHIR_JSON },
    signal,
  });

  if (result.status === 404 || result.status === 410) {
    return { status: "gone" };
  }

  if (!result.ok) {
    throw new Error(
      `Could not check the write slot (${result.status} ${result.statusText}).`,
    );
  }

  const body = (await result.json()) as QuestionnaireResponse;
  if (body.resourceType !== "QuestionnaireResponse") {
    throw new Error(`${writeUrl} does not hold a QuestionnaireResponse.`);
  }

  return body.status === "completed" || body.status === "amended"
    ? { status: "ready", response: body }
    : { status: "pending" };
}
