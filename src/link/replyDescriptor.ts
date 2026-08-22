import { isReplyPublicJwk, type ReplyPublicJwk } from "./replyCrypto";

import type { Extension, Task } from "fhir/r4";

/**
 * How a filler sends answers back - the two return channels, as `Task` extensions.
 *
 * SMART Health Links are strictly one-directional: neither the
 * [SHL spec](https://docs.smarthealthit.org/smart-health-links/spec/) nor the HL7
 * links-specification defines a submission channel, and neither mentions questionnaires at all. A
 * browser filler can work around that by publishing its own link for the requester to scan, which is
 * what `bespokeCodec` exists for. A native app cannot (it has no viewer to hand back), so a request
 * has to *say* where answers may go.
 *
 * Two channels, because they fail in different places:
 *
 * **Channel B - `invitation-server-task-url`.** Plain FHIR. The request names a `Task` on the
 * requester's own server and the Questionnaire carries `sdc-questionnaire-endpoint`; the filler does
 * an ordinary `POST /QuestionnaireResponse`. Nothing new is invented (this is SDC's Form Receiver
 * model), but the answers land on the server *unreviewed*, and the endpoint must accept writes from a
 * party holding nothing but a link.
 *
 * **Channel C - `shl-reply-descriptor`.** The request names a reply slot and a public key; the filler
 * encrypts to that key and parks the ciphertext. The requester polls, decrypts, shows a human, and
 * only then writes. Review-before-write survives, and the slot host never sees plaintext - the same
 * untrusted-host posture SHL already assumes for the outbound payload.
 *
 * ## Why the public key, and not a shared one
 *
 * An invitation is usually a QR code, so anyone who photographs it holds everything in it. A
 * symmetric reply key would therefore let a bystander read the answers. Encrypting to a *public* key
 * whose private half never leaves the requester means a leaked invitation can at worst overwrite a
 * reply with garbage, never read one. This follows Platypus's design, which got this right.
 *
 * ## Both extensions live only inside the encrypted payload
 *
 * Never in the `shlink:` string. Inspecting a link without its key reveals no slot, no token and no
 * key - `check:e2e-shl` asserts this rather than trusting it.
 */

/** Where these extensions are defined. See `docs/shl-form-reply-channel.md`. */
const STRUCTURE_DEFINITION_BASE =
  "http://smartforms.csiro.au/StructureDefinition";

export const REPLY_DESCRIPTOR_EXTENSION = `${STRUCTURE_DEFINITION_BASE}/shl-reply-descriptor`;
export const SERVER_TASK_URL_EXTENSION = `${STRUCTURE_DEFINITION_BASE}/invitation-server-task-url`;

/**
 * Platypus shipped this contract first, under its own identifiers. Read those too.
 *
 * Reading is tolerant of both namespaces. Writing is not symmetrical, and the asymmetry is
 * deliberate rather than an oversight: the reply descriptor is emitted under the vendor-neutral
 * URL above, but `invitation-server-task-url` is emitted under Platypus's, because
 * `contracts/shl-wire.md` fixes that identifier as the interoperability boundary. A Platypus
 * build must consume this app's invitations unchanged, and it looks for its own URL.
 */
const PLATYPUS_BASE = "https://platypushealth.app/StructureDefinition";

/** The `invitation-server-task-url` identifier this app emits. See {@link PLATYPUS_BASE}. */
export const PLATYPUS_SERVER_TASK_URL_EXTENSION = `${PLATYPUS_BASE}/invitation-server-task-url`;

const REPLY_DESCRIPTOR_URLS = new Set([
  REPLY_DESCRIPTOR_EXTENSION,
  `${PLATYPUS_BASE}/shl-reply-descriptor`,
]);
const SERVER_TASK_URL_URLS = new Set([
  SERVER_TASK_URL_EXTENSION,
  PLATYPUS_SERVER_TASK_URL_EXTENSION,
]);

/**
 * How the filler delivers the ciphertext.
 *
 * `PUT` is a single unconditional write to `replyUrl` - no handshake, so any file host will do,
 * including a FHIR `Binary` on a server nobody trusts. That is what makes the descriptor
 * host-neutral rather than an interface to one relay.
 *
 * `relay-grant` is Platypus's flow: exchange the token for a short-lived signed upload grant, then
 * post to that. This app can *recognise* such a slot but cannot send through one, and says so rather
 * than failing at the upload.
 */
export type ReplyMethod = "PUT" | "relay-grant";

export interface ReplyDescriptor {
  /** Absolute URL of the reply slot. */
  replyUrl: string;
  replyMethod: ReplyMethod;
  /** Replies are ECDH-ES encrypted to this. The private half stays with the requester. */
  publicJwk: ReplyPublicJwk;
  /** Slot expiry, unix seconds. Mirrors the invitation's own `exp`. */
  expiresAt?: number;
  /**
   * Capability to write to the slot, when the host gates writes.
   *
   * Never the capability to *read* one: a leaked invitation must not be able to collect the answers.
   * Absent for a plain FHIR slot, which has no such concept - the honest cost of that is recorded in
   * the README.
   */
  replyToken?: string;
}

function subExtensions(extension: Extension | undefined): Extension[] {
  return extension?.extension ?? [];
}

/**
 * First matching sub-extension value, accepting either `valueUrl` or `valueString`.
 */
function stringValue(parts: Extension[], url: string): string | undefined {
  const found = parts.find((part) => part.url === url);
  const value = found?.valueUrl ?? found?.valueString;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 *
 */
export function buildReplyDescriptorExtension(
  descriptor: ReplyDescriptor,
): Extension {
  const parts: Extension[] = [
    { url: "replyUrl", valueUrl: descriptor.replyUrl },
    { url: "replyMethod", valueCode: descriptor.replyMethod },
    // Stringified rather than modelled as sub-extensions: a JWK is defined by JOSE, and splitting it
    // across FHIR elements would invent a second encoding of it that both sides had to agree on.
    { url: "publicJwk", valueString: JSON.stringify(descriptor.publicJwk) },
  ];

  if (descriptor.expiresAt !== undefined) {
    parts.push({ url: "expiresAt", valueInteger: descriptor.expiresAt });
  }

  if (descriptor.replyToken !== undefined) {
    parts.push({ url: "replyToken", valueString: descriptor.replyToken });
  }

  return { url: REPLY_DESCRIPTOR_EXTENSION, extension: parts };
}

/**
 * Read the reply descriptor off a Task.
 *
 * Tolerant on purpose: anything missing or malformed yields `undefined` ("this request offers no
 * encrypted reply channel") rather than throwing. A filler that cannot send answers back is a
 * degraded experience; a filler that cannot open the form at all because one extension was wrong is a
 * broken one.
 */
export function parseReplyDescriptor(
  task: Task | undefined,
): ReplyDescriptor | undefined {
  const extension = task?.extension?.find((candidate) =>
    REPLY_DESCRIPTOR_URLS.has(candidate.url),
  );
  const parts = subExtensions(extension);
  if (parts.length === 0) {
    return undefined;
  }

  const replyUrl = stringValue(parts, "replyUrl");
  // `replyPostToken` is Platypus's name for the same capability.
  const replyToken =
    stringValue(parts, "replyToken") ?? stringValue(parts, "replyPostToken");
  const rawJwk = stringValue(parts, "publicJwk");
  if (!replyUrl || !rawJwk) {
    return undefined;
  }

  let publicJwk: unknown;
  try {
    publicJwk = JSON.parse(rawJwk);
  } catch {
    return undefined;
  }

  if (!isReplyPublicJwk(publicJwk)) {
    return undefined;
  }

  const declaredMethod = parts.find(
    (part) => part.url === "replyMethod",
  )?.valueCode;
  const expiresAt = parts.find(
    (part) => part.url === "expiresAt",
  )?.valueInteger;

  return {
    replyUrl,
    replyMethod: resolveReplyMethod(declaredMethod, replyToken),
    publicJwk: { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y },
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
    ...(replyToken === undefined ? {} : { replyToken }),
  };
}

/**
 * Work out how to deliver, for descriptors that predate `replyMethod`.
 *
 * Platypus's descriptor has no such field and always means its grant flow, and it always carries a
 * token - so an untyped descriptor *with* a token is a relay, and one without is a plain write. We
 * always emit `replyMethod` explicitly, so this guess only ever applies to someone else's descriptor.
 */
function resolveReplyMethod(
  declared: string | undefined,
  replyToken?: string,
): ReplyMethod {
  if (declared === "PUT" || declared === "relay-grant") {
    return declared;
  }

  return replyToken === undefined ? "PUT" : "relay-grant";
}

/**
 * Whether the descriptor's slot has passed its stated expiry.
 */
export function isReplyDescriptorExpired(
  descriptor: ReplyDescriptor,
  now = Date.now(),
): boolean {
  return (
    descriptor.expiresAt !== undefined && descriptor.expiresAt * 1000 < now
  );
}

/**
 * Build the extension naming the Task published on the requester's own server.
 *
 * Emitted under {@link PLATYPUS_SERVER_TASK_URL_EXTENSION} rather than the vendor-neutral URL,
 * because `contracts/shl-wire.md` fixes that identifier as the interoperability boundary.
 * Reading remains tolerant of both.
 * @param taskUrl absolute URL of the published Task
 * @returns the extension
 */
export function buildServerTaskUrlExtension(taskUrl: string): Extension {
  return { url: PLATYPUS_SERVER_TASK_URL_EXTENSION, valueUrl: taskUrl };
}

/**
 * Whether an extension is a usable `invitation-server-task-url`.
 *
 * Both the identifier and the value are checked, because a recognised url carrying something that
 * is not an absolute `http(s)` URL is not an address anyone can use. Exported so callers that
 * carry the extension around - the return leg keeps it while dropping the reply descriptor - can
 * select it without re-deriving what counts.
 * @param extension the candidate extension
 * @returns true when it names a Task by absolute URL under either recognised identifier
 * @example
 * const kept = (task.extension ?? []).filter(isServerTaskUrlExtension);
 */
export function isServerTaskUrlExtension(extension: Extension): boolean {
  if (!SERVER_TASK_URL_URLS.has(extension.url)) {
    return false;
  }

  const value = extension.valueUrl ?? extension.valueString;
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/**
 * Read the absolute URL of the invitation's Task on the requester's server (channel B).
 *
 * Required to be absolute and `http(s)`: a relative reference would be resolved against whatever base
 * the filler happens to be using, which is nothing to do with the requester's server.
 * @param task the Task to read it off, when there is one
 * @returns the absolute Task URL, or undefined when the Task names none
 */
export function parseServerTaskUrl(task: Task | undefined): string | undefined {
  const extension = task?.extension?.find((candidate) =>
    isServerTaskUrlExtension(candidate),
  );
  return extension?.valueUrl ?? extension?.valueString;
}

/** The return channels a request offers, for UI that has to explain what is and is not possible. */
export interface ReturnChannels {
  /** Channel C: encrypted reply slot. */
  reply?: ReplyDescriptor;
  /** Channel B: absolute Task URL on the requester's server. */
  serverTaskUrl?: string;
}

/**
 *
 */
export function parseReturnChannels(task: Task | undefined): ReturnChannels {
  const reply = parseReplyDescriptor(task);
  const serverTaskUrl = parseServerTaskUrl(task);

  return {
    ...(reply ? { reply } : {}),
    ...(serverTaskUrl ? { serverTaskUrl } : {}),
  };
}
