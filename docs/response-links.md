# Returning answers as a SMART Health Link

**Status:** implemented in
[smart-forms-health-links](https://github.com/aehrc/smart-forms-health-links), where it is the
**fallback** return path. The primary one is the token channel summarised below.
**Audience:** anyone building an app that fills in a questionnaire delivered by SMART Health Link and
needs to hand the answers back.

This document specifies what this app accepts as an _inbound response link_: the filler mints its own
SMART Health Link carrying the completed `QuestionnaireResponse`, and the requester scans or pastes it
back. It is the companion to [`shl-form-reply-channel.md`](shl-form-reply-channel.md), which
specifies the channels an invitation can _declare_; this one needs no declaration at all.

It also summarises [the token channel](#the-token-channel), which is what this app's own invitations
now offer and what it will use in preference to a returned link whenever an invitation carries one.

It is written so it can be implemented without reading our source.

## Why this way

SMART Health Links are strictly one-directional, and using one as a return transport is off-spec in
the sense that the spec never contemplates it. But nothing off-spec actually happens: the filler
_publishes_ a link, exactly as a sharer does, and the requester _reads_ it, exactly as a receiver
does. Nothing is pushed anywhere, no credential travels to the filler, and no endpoint has to accept
anonymous writes.

The requester's own app performs the write, after a human has looked at the answers. That is the
whole point: third-party data entering a clinical record should be reviewed first, and this is the
return path that preserves that without requiring anything to be arranged in advance.

The cost is that the requester has to be able to receive a QR code or a URL. When they cannot - a
patient on a phone with nobody to show it to - the answer is either the reply channel in the
companion document or, if the requester can issue tokens, [the token
channel](#the-token-channel).

## Security: what this does and does not protect

**A response link protects the answers in transit from the host, and from nobody else.** The payload
is a JWE and the key travels only in the link, so the storage host never sees plaintext. But anyone
who photographs the QR or reads the URL holds the key and can read the answers, exactly as with any
`U`-flag SHL.

If that is not acceptable for your deployment, the options are a manifest-hosted link with a passcode
(`P` flag - supported on read, see below), the encrypted reply channel, where answers are encrypted
to a public key that only the requester holds, or the token channel, where the answers never travel
through a link at all.

## The link

Any valid SMART Health Link. Both hosting modes are read:

|                | `U` flag                        | manifest                                         |
| -------------- | ------------------------------- | ------------------------------------------------ |
| Retrieval      | plain `GET` of `payload.url`    | `POST payload.url` with `{recipient, passcode?}` |
| Passcode       | not possible (`U` excludes `P`) | supported                                        |
| Multiple files | no                              | yes, all merged                                  |

Expiry (`exp`) is honoured. A `v` greater than 1 is refused rather than guessed at.

### Passcodes

A `P`-flagged link prompts for a passcode **before** any request is made. Implementers on the
serving side should note the reason: a manifest server is entitled to count a passcode-less request
as a failed attempt, and spending one of a user's limited attempts to discover a fact the payload
already states would be inexcusable. `remainingAttempts` from a 401 body is shown to the user when
present.

### Retrieval, for `U`-flag links

The `GET` carries **no `Accept` header and no query parameters**. Both matter:

- an `Accept` of `application/fhir+json` makes a FHIR server wrap the bytes in a `Binary` resource
  instead of returning the JWE; and
- appending anything to the URL - `?recipient=…`, most plausibly - makes a FHIR `Binary` read fail
  with `400 not-supported`. The SHL spec defines `recipient` as a field of the _manifest request
  body_, and defines no equivalent for `U`-flag direct retrieval.

## The payload

`application/fhir+json`, which means **any FHIR resource** - not necessarily a `Bundle`. All of these
are accepted:

```
QuestionnaireResponse                              a bare resource
Bundle{QuestionnaireResponse}                      the minimum useful bundle
Bundle{QuestionnaireResponse, Provenance}          answers plus attribution
Bundle{QuestionnaireResponse, Task, Provenance}    the full shape, with correlation
```

A bare resource is normalised into a `collection` Bundle. In a manifest, **every**
`application/fhir+json` file is read and merged into one Bundle, de-duplicating entries by `fullUrl`;
content types are matched after stripping any `;charset=…` parameter. Splitting the answers and their
`Provenance` across two files is therefore fine - they are one payload, not a choice.

Files this app cannot render (`application/smart-health-card`, for instance) are skipped and named on
screen. A file that will not decrypt costs its own content, not the whole link; a link where _nothing_
decoded is an error, because reporting "no answers" for a link that failed to decrypt would be a lie.

### Attribution

Stamp `meta.security` with `PATAST` when the answers were recorded by the person themselves rather
than by a clinician:

```json
{
  "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
  "code": "PATAST",
  "display": "patient asserted"
}
```

This is the most important field in the payload. Without it, answers typed by a patient on their own
phone are indistinguishable in the record from answers recorded by a clinician. It is preserved
through the write: a foreign `id` is stripped, but `meta.security`, `meta.profile` and `meta.tag` are
not.

A `Provenance` naming the patient as author is read and stored alongside when present. Its `target`
should reference the response's `fullUrl` - the response has no server id yet.

### Correlation

R4 gives `QuestionnaireResponse` no way to reference a `Task`, so correlation runs from the Task
outward. Echo the invitation's `Task` back if you can:

| Field                     | What to do                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identifier`              | **Preserve verbatim.** This is the only key that survives the round trip, and the only thing that ties the answers to the request that asked for them |
| `status`                  | `completed`                                                                                                                                           |
| `output[].valueReference` | the response's `fullUrl`                                                                                                                              |
| `focus`                   | **drop it** - it named a Questionnaire entry in a Bundle that no longer exists                                                                        |
| `extension`               | **drop it** - echoing a reply descriptor back copies a write capability into whatever the answers travel on, possibly an unencrypted QR               |

Without a Task the answers are still perfectly reviewable; they just cannot be matched to a request
automatically, and the reviewer is told so rather than left to wonder.

### The questionnaire

Carry it **by reference, never by value** - `QuestionnaireResponse.questionnaire`, as a canonical.
Some questionnaires are hundreds of kilobytes and the requester already has the form; re-sending it
would defeat the point of the link being small.

Expect the requester not to find it. A response cites whatever canonical the app that wrote it used,
and on a shared server that is frequently a form the receiving deployment's catalogue does not hold.
This app degrades to a flat table of answers and still allows the response to be saved: the answers
are the clinical content, and the definition is presentation.

### The subject

Expect `subject` **not to resolve** on the receiving server, and do not treat that as your problem to
solve. A filler identifies the patient in its own terms - a local vault key, most likely - and a
server enforcing referential integrity rejects the entire write (`HAPI-1094`). This app probes the
reference before enabling the save and asks the reviewer to reconcile it, offering the patient the
original request was addressed to as a one-click answer. Matching a patient is a clinical decision,
not a technical one, so it is never done silently.

## What happens on the receiving side

1. The link is scanned or pasted; the payload is fetched and decrypted locally.
2. It is dispatched on **content, not route** - a `Questionnaire` with no answers opens the form to
   be filled, anything with a `QuestionnaireResponse` opens the review.
3. The answers are rendered **read-only**. Editing another party's answers before committing them
   would blur who recorded what.
4. A human accepts, and only then is anything written: `POST /QuestionnaireResponse`, then the `Task`,
   then the `Provenance`.

Nothing is written without that step. That guarantee is the reason this return path exists in the
shape it does.

## The token channel

This is the primary return path, and it is not a response link at all. The requester's invitation
carries a credential, and the filler writes the answers into the requester's own FHIR server with
it. There is no link to hand back, nothing to scan and nothing to review, because the answers arrive
attributed to the patient rather than relayed by a third party.

It needs no new extension, no reply slot and no host. What it needs is a requester able to issue an
access token, which is why the two channels in
[`shl-form-reply-channel.md`](shl-form-reply-channel.md) remain specified for producers that cannot.

What follows is a summary sufficient to implement either side. The shapes are fixed by this
feature's wire contract (`contracts/shl-wire.md` in the specification bundle) rather than by any one
implementation, because two apps have to produce and consume the same thing.

### The manifest carries two files

The invitation is a manifest-mode link - **no `U` flag and no `P` flag**, so the manifest is fetched
by `POST` as usual. It lists exactly two files, both `embedded` and both encrypted under the link
key with `alg: dir`, `enc: A256GCM`, `cty` set to the file's own content type, and the encoded
protected header as AAD:

```json
{
  "files": [
    { "contentType": "application/fhir+json", "embedded": "<JWE compact>" },
    {
      "contentType": "application/smart-api-access",
      "embedded": "<JWE compact>"
    }
  ]
}
```

The first file is the invitation itself: a `collection` Bundle holding the whole `Questionnaire` and
the request `Task`, exactly as
[`shl-form-reply-channel.md`](shl-form-reply-channel.md#what-an-invitation-looks-like) specifies it.

**Dispatch on content type, not on position.** A manifest with only the first file is legal and
means the requester could not mint a token this time; the form must still open, and the filler
should fall back to returning a link. Treat a malformed grant as an absent one for the same reason:
a filler that cannot send is degraded, one that cannot open the form is broken.

### The grant file

Plaintext of the `application/smart-api-access` file:

```json
{
  "access_token": "<opaque>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "aud": "https://ehr.example.org/fhir",
  "patient": "pt-1"
}
```

| Field          | Card. | Meaning                                                                             |
| -------------- | ----- | ----------------------------------------------------------------------------------- |
| `access_token` | 1..1  | Bearer token. Presented only to `aud`'s origin, and never logged or persisted       |
| `token_type`   | 1..1  | `Bearer`, matched case-insensitively                                                |
| `expires_in`   | 0..1  | Stated lifetime in seconds, counted from **receipt**, not from any clock comparison |
| `aud`          | 1..1  | Absolute `https` FHIR base URL the answers are sent to                              |
| `patient`      | 0..1  | Destination patient id. Present exactly when the request named one                  |

Parse tolerantly, and treat "no grant" as the outcome of every failure: not a JSON object, no
`access_token`, `aud` missing or not `https`, or a `token_type` that is not Bearer. A missing or
absurd `expires_in` means "no stated expiry", **not** expired - refusing to send because a field was
malformed would strand answers a server would have accepted.

**Expect a different token on every fetch.** The token is minted when the manifest is fetched, not
when the link was minted, so the send window starts when the patient opens the form. Two fetches
give two tokens; caching one across fetches gains nothing and shortens the window.

### The published task, and the extension that names it

The request `Task` exists twice: once inside the invitation, and once on the requester's server. The
invitation copy names the server copy with one extension, so the filler can complete it:

```json
{
  "url": "https://platypushealth.app/StructureDefinition/invitation-server-task-url",
  "valueUrl": "https://ehr.example.org/fhir/Task/task-1"
}
```

`valueUrl` is the published Task's absolute URL. **It must be on the grant's `aud` origin.** A
filler that finds it anywhere else must skip the task leg entirely rather than present a bearer
token off-origin - not even to see whether the fetch would have worked.

### The submission transaction

One `POST {aud}` with `Authorization: Bearer <access_token>` and
`Content-Type: application/fhir+json`, carrying a `transaction` Bundle:

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "fullUrl": "urn:uuid:<qr>",
      "resource": {
        "resourceType": "QuestionnaireResponse",
        "status": "completed",
        "questionnaire": "<canonical>|<version>",
        "identifier": {
          "system": "urn:ietf:rfc:3986",
          "value": "urn:uuid:<requestIdentifier>"
        },
        "meta": {
          "security": [
            {
              "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
              "code": "PATAST",
              "display": "patient asserted"
            }
          ]
        },
        "subject": { "reference": "Patient/pt-1", "display": "Jane Citizen" },
        "item": ["…"]
      },
      "request": {
        "method": "POST",
        "url": "QuestionnaireResponse",
        "ifNoneExist": "identifier=urn:ietf:rfc:3986|urn:uuid:<requestIdentifier>"
      }
    },
    {
      "fullUrl": "urn:uuid:<prov>",
      "resource": {
        "resourceType": "Provenance",
        "target": [{ "reference": "urn:uuid:<qr>" }],
        "recorded": "<now>",
        "agent": [
          {
            "type": {
              "coding": [
                {
                  "system": "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
                  "code": "author"
                }
              ]
            },
            "who": { "reference": "Patient/pt-1", "display": "Jane Citizen" }
          }
        ]
      },
      "request": { "method": "POST", "url": "Provenance" }
    },
    {
      "resource": {
        "resourceType": "Task",
        "id": "task-1",
        "status": "completed",
        "output": [
          {
            "type": { "text": "questionnaire-response" },
            "valueReference": { "reference": "urn:uuid:<qr>" }
          }
        ]
      },
      "request": {
        "method": "PUT",
        "url": "Task/task-1",
        "ifMatch": "W/\"<versionId>\""
      }
    }
  ]
}
```

Rules, in the order they bite:

- **`ifNoneExist` is what makes a resend safe**, keyed on the request's durable identifier. Its
  casing is exact: at least one server is case-sensitive about the field, and a misspelling silently
  creates a second response instead of failing.
- **`subject` and `agent.who` appear exactly when the grant named a `patient`.** Otherwise omit them
  entirely. Never substitute a filler-local reference - it means nothing on the destination and
  files the answers against a patient that does not exist there.
- **`PATAST` on `meta.security` is the most important field in the payload.** Without it, answers a
  patient typed on their phone are indistinguishable in the record from answers a clinician recorded.
- **The Task entry is conditional on three things**: the extension's URL is on `aud`'s origin, a
  Bearer-authorised `GET` of it immediately beforehand found the Task still actionable, and that
  read returned a version to `ifMatch` against. Any of those failing means no Task entry and the
  answers go anyway. Losing the status flip costs the requester a tidy list; losing the answers
  costs a patient the time they spent typing them.
- **The Provenance is a plain `POST`.** There is no conditional-create key for it, so a replayed
  transaction leaves one response, one completed task and **two** provenances. That is a known and
  accepted cost of keeping the shape interoperable.
- **The token goes to one origin only.** Use `redirect: "manual"` and treat any redirect as a
  failure: following it would hand a write credential for a clinical record to whoever controls the
  target, while reporting the answers as delivered.
- **Success is a 2xx on the transaction, and nothing more.** Say the answers were accepted by the
  destination host; do not claim anybody has read them.

### When the window has closed

`expires_in` counted from receipt is the whole of the expiry logic - not a comparison between the
filler's clock and the server's, which can differ by more than the window.

Once it has passed, offer no direct send and make no request to the destination. Say plainly that
the window has closed and promote the fallback: mint a response link and let the requester scan it,
exactly as the rest of this document describes. An authorisation refusal from the destination closes
the channel for that invitation the same way. In both cases the answers stay on the device and
nothing reads as delivered.
