import type { Extension, Task } from 'fhir/r4';
import { isReplyPublicJwk, type ReplyPublicJwk } from './replyCrypto';

/**
 * How a filler sends answers back — the two return channels, as `Task` extensions.
 *
 * SMART Health Links are strictly one-directional: neither the
 * [SHL spec](https://docs.smarthealthit.org/smart-health-links/spec/) nor the HL7
 * links-specification defines a submission channel, and neither mentions questionnaires at all. A
 * browser filler can work around that by publishing its own link for the requester to scan, which is
 * what `bespokeCodec` exists for. A native app cannot — it has no viewer to hand back — so a request
 * has to *say* where answers may go.
 *
 * Two channels, because they fail in different places:
 *
 * **Channel B — `invitation-server-task-url`.** Plain FHIR. The request names a `Task` on the
 * requester's own server and the Questionnaire carries `sdc-questionnaire-endpoint`; the filler does
 * an ordinary `POST /QuestionnaireResponse`. Nothing new is invented — this is SDC's Form Receiver
 * model — but the answers land on the server *unreviewed*, and the endpoint must accept writes from a
 * party holding nothing but a link.
 *
 * **Channel C — `shl-reply-descriptor`.** The request names a reply slot and a public key; the filler
 * encrypts to that key and parks the ciphertext. The requester polls, decrypts, shows a human, and
 * only then writes. Review-before-write survives, and the slot host never sees plaintext — the same
 * untrusted-host posture SHL already assumes for the outbound payload.
 *
 * **Channel D — `shl-write-descriptor`.** The request pre-allocates an empty `QuestionnaireResponse`
 * and names its absolute URL, the `If-Match` ETag that addresses its current version, and a write
 * token. The filler `PUT`s the completed answers there. It is channel B with the two things B lacked:
 * a *bounded* capability rather than an open endpoint, and a slot staged off the record server so the
 * requester still reviews before anything is written. What it gives up against channel C is
 * confidentiality from the host — the payload is plaintext FHIR — in exchange for a filler that needs
 * no bespoke crypto to answer.
 *
 * ## Why "once" is a property of the wire, not of the token
 *
 * The `PUT` is conditional on `writeEtag`. A second write collides with the version the first one
 * created and any conformant FHIR server refuses it (`409`/`412`) — including the public HAPI this
 * repo tests against, which has no notion of tokens at all. So the once-only guarantee holds without
 * any authorisation infrastructure, and `writeToken` is the *additional* gate for hosts that can
 * enforce one. On a host that cannot, it is advisory, and the README says so rather than implying a
 * protection that is not there.
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
 * key — `check:e2e-shl` asserts this rather than trusting it.
 */

/** Where these extensions are defined. See `docs/shl-form-reply-channel.md`. */
const STRUCTURE_DEFINITION_BASE = 'http://smartforms.csiro.au/StructureDefinition';

export const REPLY_DESCRIPTOR_EXTENSION = `${STRUCTURE_DEFINITION_BASE}/shl-reply-descriptor`;
export const SERVER_TASK_URL_EXTENSION = `${STRUCTURE_DEFINITION_BASE}/invitation-server-task-url`;
export const WRITE_DESCRIPTOR_EXTENSION = `${STRUCTURE_DEFINITION_BASE}/shl-write-descriptor`;

/**
 * Platypus shipped this contract first, under its own identifiers. Read those too.
 *
 * Read tolerantly, write narrowly: a Platypus invitation opens here unchanged, but we only ever emit
 * the vendor-neutral URLs above, so a third party never has to adopt one vendor's namespace to
 * participate.
 */
const PLATYPUS_BASE = 'https://platypushealth.app/StructureDefinition';

const REPLY_DESCRIPTOR_URLS = [REPLY_DESCRIPTOR_EXTENSION, `${PLATYPUS_BASE}/shl-reply-descriptor`];
const SERVER_TASK_URL_URLS = [
  SERVER_TASK_URL_EXTENSION,
  `${PLATYPUS_BASE}/invitation-server-task-url`
];
const WRITE_DESCRIPTOR_URLS = [WRITE_DESCRIPTOR_EXTENSION, `${PLATYPUS_BASE}/shl-write-descriptor`];

/**
 * How the filler delivers the ciphertext.
 *
 * `PUT` is a single unconditional write to `replyUrl` — no handshake, so any file host will do,
 * including a FHIR `Binary` on a server nobody trusts. That is what makes the descriptor
 * host-neutral rather than an interface to one relay.
 *
 * `relay-grant` is Platypus's flow: exchange the token for a short-lived signed upload grant, then
 * post to that. This app can *recognise* such a slot but cannot send through one, and says so rather
 * than failing at the upload.
 */
export type ReplyMethod = 'PUT' | 'relay-grant';

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
   * Absent for a plain FHIR slot, which has no such concept — the honest cost of that is recorded in
   * the README.
   */
  replyToken?: string;
}

function subExtensions(extension: Extension | undefined): Extension[] {
  return extension?.extension ?? [];
}

/** First matching sub-extension value, accepting either `valueUrl` or `valueString`. */
function stringValue(parts: Extension[], url: string): string | undefined {
  const found = parts.find((part) => part.url === url);
  const value = found?.valueUrl ?? found?.valueString;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function buildReplyDescriptorExtension(descriptor: ReplyDescriptor): Extension {
  const parts: Extension[] = [
    { url: 'replyUrl', valueUrl: descriptor.replyUrl },
    { url: 'replyMethod', valueCode: descriptor.replyMethod },
    // Stringified rather than modelled as sub-extensions: a JWK is defined by JOSE, and splitting it
    // across FHIR elements would invent a second encoding of it that both sides had to agree on.
    { url: 'publicJwk', valueString: JSON.stringify(descriptor.publicJwk) }
  ];

  if (descriptor.expiresAt !== undefined) {
    parts.push({ url: 'expiresAt', valueInteger: descriptor.expiresAt });
  }

  if (descriptor.replyToken !== undefined) {
    parts.push({ url: 'replyToken', valueString: descriptor.replyToken });
  }

  return { url: REPLY_DESCRIPTOR_EXTENSION, extension: parts };
}

/**
 * Read the reply descriptor off a Task.
 *
 * Tolerant on purpose: anything missing or malformed yields `undefined` — "this request offers no
 * encrypted reply channel" — rather than throwing. A filler that cannot send answers back is a
 * degraded experience; a filler that cannot open the form at all because one extension was wrong is a
 * broken one.
 */
export function parseReplyDescriptor(task: Task | undefined): ReplyDescriptor | undefined {
  const extension = task?.extension?.find((candidate) =>
    REPLY_DESCRIPTOR_URLS.includes(candidate.url)
  );
  const parts = subExtensions(extension);
  if (parts.length === 0) {
    return undefined;
  }

  const replyUrl = stringValue(parts, 'replyUrl');
  // `replyPostToken` is Platypus's name for the same capability.
  const replyToken = stringValue(parts, 'replyToken') ?? stringValue(parts, 'replyPostToken');
  const rawJwk = stringValue(parts, 'publicJwk');
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

  const declaredMethod = parts.find((part) => part.url === 'replyMethod')?.valueCode;
  const expiresAt = parts.find((part) => part.url === 'expiresAt')?.valueInteger;

  return {
    replyUrl,
    replyMethod: resolveReplyMethod(declaredMethod, replyToken),
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    ...(replyToken !== undefined ? { replyToken } : {})
  };
}

/**
 * Work out how to deliver, for descriptors that predate `replyMethod`.
 *
 * Platypus's descriptor has no such field and always means its grant flow, and it always carries a
 * token — so an untyped descriptor *with* a token is a relay, and one without is a plain write. We
 * always emit `replyMethod` explicitly, so this guess only ever applies to someone else's descriptor.
 */
function resolveReplyMethod(declared: string | undefined, replyToken?: string): ReplyMethod {
  if (declared === 'PUT' || declared === 'relay-grant') {
    return declared;
  }

  return replyToken === undefined ? 'PUT' : 'relay-grant';
}

/** Whether the descriptor's slot has passed its stated expiry. */
export function isReplyDescriptorExpired(descriptor: ReplyDescriptor, now = Date.now()): boolean {
  return descriptor.expiresAt !== undefined && descriptor.expiresAt * 1000 < now;
}

export function buildServerTaskUrlExtension(taskUrl: string): Extension {
  return { url: SERVER_TASK_URL_EXTENSION, valueUrl: taskUrl };
}

/**
 * Read the absolute URL of the invitation's Task on the requester's server (channel B).
 *
 * Required to be absolute and `http(s)`: a relative reference would be resolved against whatever base
 * the filler happens to be using, which is nothing to do with the requester's server.
 */
export function parseServerTaskUrl(task: Task | undefined): string | undefined {
  const extension = task?.extension?.find((candidate) => SERVER_TASK_URL_URLS.includes(candidate.url));
  const value = extension?.valueUrl ?? extension?.valueString;
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined;
}

/**
 * How the filler delivers the answers to a write slot.
 *
 * `PUT` is the only value specified, and the only one that can be conditional: a `POST` has nothing
 * to be conditional *on*, so it could not be once. The union exists so an unrecognised method is a
 * parse failure — "this invitation offers no write channel" — rather than something to guess at.
 */
export type WriteMethod = 'PUT';

export interface WriteDescriptor {
  /** Absolute `https` URL of the pre-allocated QuestionnaireResponse. */
  writeUrl: string;
  writeMethod: WriteMethod;
  /**
   * What to send in `If-Match`, addressing the version the slot is at now.
   *
   * This is what makes the write happen at most once, so a descriptor without it is a strictly
   * weaker offer: still a location, no longer a *single* write. Absent means unconditional, which a
   * filler is entitled to honour but a requester should not mint.
   */
  writeEtag?: string;
  /**
   * Capability to perform the write, for hosts that gate them.
   *
   * Never a capability to *read* the slot. A plain FHIR server ignores it entirely — see the note on
   * once-ness at the top of this file.
   */
  writeToken?: string;
  /** Slot expiry, unix seconds. Mirrors the invitation's own `exp`. */
  expiresAt?: number;
}

/**
 * Whether a URL taken from an untrusted link may be written to.
 *
 * `https` only, and no loopback or link-local host. Nothing legitimate asks a filler to post a
 * patient's answers to the filler's own device or to a metadata service, and this address arrives
 * inside link content that anyone who reached the recipient could have authored.
 */
export function isSafeWriteUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  return !(
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^fe80:/i.test(host)
  );
}

export function buildWriteDescriptorExtension(descriptor: WriteDescriptor): Extension {
  const parts: Extension[] = [
    { url: 'writeUrl', valueUrl: descriptor.writeUrl },
    { url: 'writeMethod', valueCode: descriptor.writeMethod }
  ];

  if (descriptor.writeEtag !== undefined) {
    parts.push({ url: 'writeEtag', valueString: descriptor.writeEtag });
  }

  if (descriptor.writeToken !== undefined) {
    parts.push({ url: 'writeToken', valueString: descriptor.writeToken });
  }

  if (descriptor.expiresAt !== undefined) {
    parts.push({ url: 'expiresAt', valueInteger: descriptor.expiresAt });
  }

  return { url: WRITE_DESCRIPTOR_EXTENSION, extension: parts };
}

/**
 * Read the one-shot write descriptor off a Task.
 *
 * Tolerant for the same reason {@link parseReplyDescriptor} is, with one addition: an unsafe
 * `writeUrl` is dropped here at the *parse*, not only at the send. A filler that cannot contact an
 * address should not be offered a button that always fails — an unusable address is the same case as
 * a missing one, which is the rule Platypus arrived at independently for its own reply slots.
 */
export function parseWriteDescriptor(task: Task | undefined): WriteDescriptor | undefined {
  const extension = task?.extension?.find((candidate) =>
    WRITE_DESCRIPTOR_URLS.includes(candidate.url)
  );
  const parts = subExtensions(extension);
  if (parts.length === 0) {
    return undefined;
  }

  const writeUrl = stringValue(parts, 'writeUrl');
  if (!writeUrl || !isSafeWriteUrl(writeUrl)) {
    return undefined;
  }

  // Absent means PUT — there is nothing else specified — but a method that is present and is
  // something else is a channel we do not understand rather than one to attempt anyway.
  const declaredMethod = parts.find((part) => part.url === 'writeMethod')?.valueCode;
  if (declaredMethod !== undefined && declaredMethod !== 'PUT') {
    return undefined;
  }

  const writeEtag = stringValue(parts, 'writeEtag');
  const writeToken = stringValue(parts, 'writeToken');
  const expiresAt = parts.find((part) => part.url === 'expiresAt')?.valueInteger;

  return {
    writeUrl,
    writeMethod: 'PUT',
    ...(writeEtag !== undefined ? { writeEtag } : {}),
    ...(writeToken !== undefined ? { writeToken } : {}),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {})
  };
}

/** Whether the descriptor's slot has passed its stated expiry. */
export function isWriteDescriptorExpired(descriptor: WriteDescriptor, now = Date.now()): boolean {
  return descriptor.expiresAt !== undefined && descriptor.expiresAt * 1000 < now;
}

/**
 * The id a slot URL addresses, which the written resource has to carry.
 *
 * FHIR `update` requires `resource.id` to match the id in the URL, so this is the one channel where
 * the filler must *keep* an id rather than strip it. That is not the filler's identity leaking into
 * someone else's server — it is the address being written to.
 */
export function writeSlotId(writeUrl: string): string | undefined {
  const id = writeUrl.split(/[?#]/, 1)[0]?.replace(/\/+$/, '').split('/').pop();
  return id !== undefined && id !== '' ? id : undefined;
}

/** The return channels a request offers, for UI that has to explain what is and is not possible. */
export interface ReturnChannels {
  /** Channel C: encrypted reply slot. */
  reply?: ReplyDescriptor;
  /** Channel D: a pre-allocated slot the answers may be written to once. */
  write?: WriteDescriptor;
  /** Channel B: absolute Task URL on the requester's server. */
  serverTaskUrl?: string;
}

export function parseReturnChannels(task: Task | undefined): ReturnChannels {
  const reply = parseReplyDescriptor(task);
  const write = parseWriteDescriptor(task);
  const serverTaskUrl = parseServerTaskUrl(task);

  return {
    ...(reply ? { reply } : {}),
    ...(write ? { write } : {}),
    ...(serverTaskUrl ? { serverTaskUrl } : {})
  };
}
