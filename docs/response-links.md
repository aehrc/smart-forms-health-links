# Returning answers as a SMART Health Link

**Status:** implemented in
[smart-forms-health-links](https://github.com/aehrc/smart-forms-health-links).
**Audience:** anyone building an app that fills in a questionnaire delivered by SMART Health Link and
needs to hand the answers back.

This document specifies what this app accepts as an *inbound response link*: the filler mints its own
SMART Health Link carrying the completed `QuestionnaireResponse`, and the requester scans or pastes it
back. It is the companion to [`shl-form-reply-channel.md`](shl-form-reply-channel.md), which
specifies the channels an invitation can *declare*; this one needs no declaration at all.

It is written so it can be implemented without reading our source.

## Why this way

SMART Health Links are strictly one-directional, and using one as a return transport is off-spec in
the sense that the spec never contemplates it. But nothing off-spec actually happens: the filler
*publishes* a link, exactly as a sharer does, and the requester *reads* it, exactly as a receiver
does. Nothing is pushed anywhere, no credential travels to the filler, and no endpoint has to accept
anonymous writes.

The requester's own app performs the write, after a human has looked at the answers. That is the
whole point: third-party data entering a clinical record should be reviewed first, and this is the
return path that preserves that without requiring anything to be arranged in advance.

The cost is that the requester has to be able to receive a QR code or a URL. When they cannot — a
patient on a phone with nobody to show it to — that is what the reply channel in the companion
document is for.

## Security: what this does and does not protect

**A response link protects the answers in transit from the host, and from nobody else.** The payload
is a JWE and the key travels only in the link, so the storage host never sees plaintext. But anyone
who photographs the QR or reads the URL holds the key and can read the answers, exactly as with any
`U`-flag SHL.

If that is not acceptable for your deployment, the options are a manifest-hosted link with a passcode
(`P` flag — supported on read, see below) or the encrypted reply channel, where answers are encrypted
to a public key that only the requester holds.

## The link

Any valid SMART Health Link. Both hosting modes are read:

| | `U` flag | manifest |
| --- | --- | --- |
| Retrieval | plain `GET` of `payload.url` | `POST payload.url` with `{recipient, passcode?}` |
| Passcode | not possible (`U` excludes `P`) | supported |
| Multiple files | no | yes, all merged |

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
- appending anything to the URL — `?recipient=…`, most plausibly — makes a FHIR `Binary` read fail
  with `400 not-supported`. The SHL spec defines `recipient` as a field of the *manifest request
  body*, and defines no equivalent for `U`-flag direct retrieval.

## The payload

`application/fhir+json`, which means **any FHIR resource** — not necessarily a `Bundle`. All of these
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
`Provenance` across two files is therefore fine — they are one payload, not a choice.

Files this app cannot render (`application/smart-health-card`, for instance) are skipped and named on
screen. A file that will not decrypt costs its own content, not the whole link; a link where *nothing*
decoded is an error, because reporting "no answers" for a link that failed to decrypt would be a lie.

### Attribution

Stamp `meta.security` with `PATAST` when the answers were recorded by the person themselves rather
than by a clinician:

```json
{ "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
  "code": "PATAST", "display": "patient asserted" }
```

This is the most important field in the payload. Without it, answers typed by a patient on their own
phone are indistinguishable in the record from answers recorded by a clinician. It is preserved
through the write: a foreign `id` is stripped, but `meta.security`, `meta.profile` and `meta.tag` are
not.

A `Provenance` naming the patient as author is read and stored alongside when present. Its `target`
should reference the response's `fullUrl` — the response has no server id yet.

### Correlation

R4 gives `QuestionnaireResponse` no way to reference a `Task`, so correlation runs from the Task
outward. Echo the invitation's `Task` back if you can:

| Field | What to do |
| --- | --- |
| `identifier` | **Preserve verbatim.** This is the only key that survives the round trip, and the only thing that ties the answers to the request that asked for them |
| `status` | `completed` |
| `output[].valueReference` | the response's `fullUrl` |
| `focus` | **drop it** — it named a Questionnaire entry in a Bundle that no longer exists |
| `extension` | **drop it** — echoing a reply descriptor back copies a write capability into whatever the answers travel on, possibly an unencrypted QR |

Without a Task the answers are still perfectly reviewable; they just cannot be matched to a request
automatically, and the reviewer is told so rather than left to wonder.

### The questionnaire

Carry it **by reference, never by value** — `QuestionnaireResponse.questionnaire`, as a canonical.
Some questionnaires are hundreds of kilobytes and the requester already has the form; re-sending it
would defeat the point of the link being small.

Expect the requester not to find it. A response cites whatever canonical the app that wrote it used,
and on a shared server that is frequently a form the receiving deployment's catalogue does not hold.
This app degrades to a flat table of answers and still allows the response to be saved: the answers
are the clinical content, and the definition is presentation.

### The subject

Expect `subject` **not to resolve** on the receiving server, and do not treat that as your problem to
solve. A filler identifies the patient in its own terms — a local vault key, most likely — and a
server enforcing referential integrity rejects the entire write (`HAPI-1094`). This app probes the
reference before enabling the save and asks the reviewer to reconcile it, offering the patient the
original request was addressed to as a one-click answer. Matching a patient is a clinical decision,
not a technical one, so it is never done silently.

## What happens on the receiving side

1. The link is scanned or pasted; the payload is fetched and decrypted locally.
2. It is dispatched on **content, not route** — a `Questionnaire` with no answers opens the form to
   be filled, anything with a `QuestionnaireResponse` opens the review.
3. The answers are rendered **read-only**. Editing another party's answers before committing them
   would blur who recorded what.
4. A human accepts, and only then is anything written: `POST /QuestionnaireResponse`, then the `Task`,
   then the `Provenance`.

Nothing is written without that step. That guarantee is the reason this return path exists in the
shape it does.
