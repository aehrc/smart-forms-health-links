# Returning answers to a SMART Health Link form request

**Status:** proposal, implemented in
[smart-forms-health-links](https://github.com/aehrc/smart-forms-health-links) — **and off by
default there.**
**Audience:** anyone building an app that fills in a questionnaire delivered by SMART Health Link.

This document specifies three ways for a filler to return a completed `QuestionnaireResponse` to
whoever asked for it. All are declared on the invitation's `Task`, all are optional, and an
invitation may offer any of them, all of them, or none.

> **What "off by default" means, and does not mean.**
>
> The primary return path is now the one that needs no arrangement at all: the filler mints its own
> SMART Health Link carrying the `QuestionnaireResponse`, and the requester scans it back. Nothing
> has to be declared on the invitation for that, so by default an invitation from
> smart-forms-health-links offers **no** reply channel and the `Task` carries no extensions. What
> this app accepts as an inbound response link is specified in
> [`response-links.md`](response-links.md).
>
> The *inbound* side is unaffected. This app still parses reply descriptors tolerantly — including
> Platypus's own extension URLs and its `replyPostToken` field name — and still delivers answers
> through a channel an invitation asks for. Refusing to honour someone else's return channel would
> strand their answers, not protect anyone. Nothing specified below has changed, and a filler that
> implements it interoperates exactly as before.
>
> Deployments that need this channel offered on their own invitations set `enableEncryptedReply`.

It is written so it can be implemented without reading our source.

## The problem

[SMART Health Links](https://docs.smarthealthit.org/smart-health-links/spec/) are strictly
one-directional. Neither the SHL spec nor the HL7
[links-specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html)
defines a submission, upload or writeback channel, and neither mentions questionnaires or requests
for data at all.

That is workable if the filler is a browser: it can publish its *own* link and let the requester scan
it, which needs no new contract. It does not work for a native app, which has no viewer to hand back
and no way to get a QR code onto the requester's screen. Something in the invitation has to say where
answers may go.

Three channels, because they fail in different places.

| | Channel B — server write | Channel C — encrypted reply | Channel D — one-shot write |
|---|---|---|---|
| Transport | `POST` to a FHIR endpoint | ciphertext into a reply slot | conditional `PUT` into a pre-allocated resource |
| Filler needs | reachability of the requester's server | ECDH-ES + A256GCM | nothing but `PUT` |
| Requester needs | a writable endpoint | nothing beyond what SHL already needs | any FHIR server it can create on |
| Bounded capability? | **no** — an open endpoint | yes — one slot | yes — one slot, one write |
| Writable more than once? | yes | yes, last one wins | **no** — the second is refused |
| Reviewed before it lands? | **no** | yes | yes |
| Host sees plaintext? | yes — it is the record | no | yes — but it is transport, not the record |
| New extension? | one, to name the Task | one | one |

**Channel C is still the one to implement if you implement only one.** It is the only channel where
the host cannot read the answers, and the only one that needs no server-side state from the requester
beyond a file.

**Channel D is the one to implement if the filler cannot do the crypto.** That is not a hypothetical:
channel C asks every third-party filler for ECDH-ES in Direct Key Agreement mode with a hand-rolled
Concat-KDF, and a filler that gets it subtly wrong produces ciphertext nobody can read. Channel D asks
for a `PUT`. What it costs is confidentiality from the slot host, which is why it is a replacement for
B rather than for C.

**Channel B is superseded.** It is documented here because invitations in the wild carry it and a
filler should still understand it, but nothing new should offer it: it names a record server, carries
no capability, cannot be made single-use, and lands answers unreviewed. Every one of those is fixed in
D.

## What an invitation looks like

Unchanged from a plain SHL, except for what is on the `Task`. The link is an ordinary
`shlink:/` payload with the `U` flag, resolving to a single JWE (`alg: dir`, `enc: A256GCM`) whose
plaintext is a `collection` Bundle:

```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    { "fullUrl": "urn:uuid:…", "resource": { "resourceType": "Questionnaire", "…": "…" } },
    { "fullUrl": "urn:uuid:…", "resource": { "resourceType": "Task", "…": "…" } }
  ]
}
```

The `Questionnaire` travels whole, so the form opens and fills with no access to any forms server.

### The Task

```json
{
  "resourceType": "Task",
  "status": "requested",
  "intent": "order",
  "identifier": [{ "system": "urn:ietf:rfc:3986", "value": "urn:uuid:3fb1cde7-…" }],
  "authoredOn": "2026-08-04T02:15:00.000Z",
  "description": "Complete \"GP Chronic Condition Management Plan\"",
  "requester": { "display": "Parkview Medical Centre" },
  "for": { "reference": "Patient/137287372", "display": "Jane Citizen" },
  "focus": {
    "reference": "http://www.health.gov.au/assessments/GPChronicConditionManagementPlan|0.1.0",
    "type": "Questionnaire",
    "display": "GP Chronic Condition Management Plan"
  },
  "input": [
    {
      "type": { "text": "questionnaire" },
      "valueCanonical": "http://www.health.gov.au/assessments/GPChronicConditionManagementPlan|0.1.0"
    }
  ],
  "extension": [ "…see below…" ]
}
```

Four things are worth calling out, because each exists for a reason a reader will otherwise
reasonably undo:

- **`focus.reference` is the Questionnaire's canonical, not the `urn:uuid` of its Bundle entry.**
  A urn:uuid is arguably better FHIR for a bundled resource, but it stops meaning anything the moment
  the Bundle is taken apart, and a filler holding only the Task then cannot say which form it has.
  `focus.type` is `Questionnaire` and must be set *together with* the canonical: readers exist that
  short-circuit on `focus.type === 'Questionnaire'` and stop consulting `input`, so a `type` alongside
  a urn:uuid reference is worse than neither.
- **`input[].valueCanonical` repeats the canonical.** `focus` is dropped on the return leg, where the
  Questionnaire is no longer in the payload and the reference would dangle. `input` is what survives.
- **`for` carries a `display` as well as a `reference`.** A filler cannot resolve a reference into a
  server it has no access to, so the name is the only part of "who is this for" that reaches it — and
  it is what lets a filler warn that a form names someone other than the person holding the device.
- **`identifier` is the durable correlation key.** `urn:uuid` references inside the Bundle do not
  survive the round trip; this does.

## Channel C — encrypted reply

### The descriptor

`http://smartforms.csiro.au/StructureDefinition/shl-reply-descriptor`, on the `Task`:

```json
{
  "url": "http://smartforms.csiro.au/StructureDefinition/shl-reply-descriptor",
  "extension": [
    { "url": "replyUrl", "valueUrl": "https://hapi.fhir.org/baseR4/Binary/137287373" },
    { "url": "replyMethod", "valueCode": "PUT" },
    { "url": "publicJwk", "valueString": "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"…\",\"y\":\"…\"}" },
    { "url": "expiresAt", "valueInteger": 1786000000 }
  ]
}
```

| Field | Card. | Meaning |
|---|---|---|
| `replyUrl` | 1..1 | Absolute `https` URL of the reply slot. Accept `valueUrl` or `valueString`. |
| `replyMethod` | 0..1 | How to deliver. `PUT` is specified here. Absent means `PUT`, unless a token is present (see below). |
| `publicJwk` | 1..1 | Stringified P-256 public JWK. Replies are encrypted to this. |
| `expiresAt` | 0..1 | Unix seconds. Mirrors the link's own `exp`. |
| `replyToken` | 0..1 | Capability to *write* the slot, for hosts that gate writes. Never the capability to read one. |

**The descriptor appears only inside the encrypted payload — never in the `shlink:` string.**
Inspecting a link without its key must reveal no slot, no token and no key.

**`publicJwk` is a public key.** It must never carry `d`. Encrypting to a public key rather than to a
symmetric key carried in the invitation is the whole point: an invitation is usually a QR code, so
anyone who photographs it holds everything in it, and a symmetric reply key would let a bystander read
the answers. Here a leaked invitation can at worst destroy a reply, never read one.

Parse tolerantly. Anything missing or malformed means "this invitation offers no encrypted reply
channel", not an error — a filler that cannot send answers back is degraded; one that cannot open the
form because an extension was wrong is broken.

### Delivering the reply

```
PUT {replyUrl}
Content-Type: application/jose

<reply JWE>
```

An unconditional overwrite. The slot holds the latest reply, so a filler correcting and resending
replaces rather than accumulates, and the requester correlates by *which slot* the reply arrived in
rather than by anything in the reply itself.

A slot that has not been answered holds something that is not a JWE. The requester decides
"answered" structurally — five dot-separated segments — not by comparing against a sentinel, so hosts
are free to represent "empty" however they like.

> Implementation note: whatever placeholder a requester writes when minting a slot must be **unique
> per slot**. A fixed one makes every slot after the first a byte-identical create, and servers that
> deduplicate refuse it outright (`HAPI-2840: Can not create resource duplicating existing resource`).

### The reply JWE

ECDH-ES in Direct Key Agreement mode + A256GCM — RFC 7518 §4.6. Compact serialisation, five
segments, encrypted-key segment **empty** (the agreed key *is* the content encryption key):

```
BASE64URL(protected header) . <empty> . BASE64URL(iv) . BASE64URL(ciphertext) . BASE64URL(tag)
```

```json
{ "alg": "ECDH-ES", "enc": "A256GCM", "epk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }
```

- `epk` is a **fresh ephemeral keypair per reply**. Its public half goes in the header; its private
  half is discarded.
- AAD is the ASCII bytes of the *encoded* protected header segment.
- `apu` and `apv` are absent, and Concat-KDF hashes them as zero-length.
- CEK = Concat-KDF (NIST SP 800-56A §5.8.1, single SHA-256 round, counter = 1):

```
SHA-256( uint32(1) ‖ Z ‖ uint32(7) ‖ "A256GCM" ‖ uint32(0) ‖ uint32(0) ‖ uint32(256) )
```

where `Z` is the raw ECDH shared secret. `AlgorithmID` is the **`enc`** value, not `alg`.
`SuppPubInfo` is the key length in **bits**. Getting either wrong produces a plausible-looking key
that simply fails to decrypt, so verify against an independent implementation rather than only
round-tripping against your own.

Reject a reply whose header says `alg: dir`. Accepting it would let anyone holding the link's
symmetric key read the answers.

### The reply payload

A `collection` Bundle: the completed `QuestionnaireResponse`, and a `Provenance` naming who asserted
it.

```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    {
      "fullUrl": "urn:uuid:a1b2…",
      "resource": {
        "resourceType": "QuestionnaireResponse",
        "status": "completed",
        "questionnaire": "http://www.health.gov.au/assessments/GPChronicConditionManagementPlan|0.1.0",
        "subject": { "reference": "Patient/local-key", "display": "Jane Citizen" },
        "meta": {
          "security": [
            {
              "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
              "code": "PATAST",
              "display": "patient asserted"
            }
          ]
        },
        "item": [ "…" ]
      }
    },
    {
      "fullUrl": "urn:uuid:c3d4…",
      "resource": {
        "resourceType": "Provenance",
        "target": [{ "reference": "urn:uuid:a1b2…" }],
        "recorded": "2026-08-04T03:00:00.000Z",
        "agent": [
          {
            "type": {
              "coding": [
                {
                  "system": "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
                  "code": "author",
                  "display": "Author"
                }
              ]
            },
            "who": { "reference": "Patient/local-key" }
          }
        ]
      }
    },
    { "fullUrl": "urn:uuid:e5f6…", "resource": { "resourceType": "Task", "status": "completed", "…": "…" } }
  ]
}
```

Rules:

- **Strip the local `id`.** It is identity from the filler's own store and means nothing to the
  requester; keeping it risks colliding with an unrelated resource there.
- **Stamp `meta.security` with `PATAST`** when the answers were entered by the patient. This is the
  most important field in the payload. Without it, answers typed on a patient's phone are
  indistinguishable in the record from answers a clinician recorded.
- **Do not echo the reply descriptor back.** Returning the slot URL, and especially a `replyToken`,
  copies a write capability into the response — possibly into an unencrypted QR code.
- **Echo the `Task`** if you can. `status: 'completed'`, `output[].valueReference` pointing at the
  response's `fullUrl`, `focus` dropped, `identifier` preserved. It is what lets a requester with
  several outstanding requests for the same form tell the answers apart. Optional: a requester that
  polls a specific slot already knows which request was answered.
- `subject.reference` will not resolve on the requester's server. That is expected and is the
  requester's problem to reconcile — see below.

### Collecting a reply

`GET {replyUrl}` with **no `Accept` header**: a FHIR server returns a `Binary` resource wrapper for
`application/fhir+json`, whereas what is wanted is the stored bytes. Five dot-separated segments means
a reply; anything else means pending. `404`/`410` means the slot is gone — a normal end state for a
request nobody answered.

## Channel D — one-shot write

### The idea

The requester creates an **empty `QuestionnaireResponse`** and tells the filler its address, the
version it is at, and a token. The filler `PUT`s the answers to that address, conditionally on that
version. The first write succeeds; every write after it collides with the version the first one
created and is refused by the server's own optimistic locking.

That is the whole mechanism, and it is worth being precise about why it is built this way: **"once" is
a property of the wire, not of the token.** Any conformant FHIR server enforces `If-Match` — the
public HAPI this was developed against refuses the second write with
`HAPI-0989: Trying to update QuestionnaireResponse/4977/_history/1 but this is not the current
version` — and none of them know anything about bearer tokens. So the single-use guarantee holds on
infrastructure that already exists, with no authorisation tier to stand up.

### The descriptor

`http://smartforms.csiro.au/StructureDefinition/shl-write-descriptor`, on the `Task`:

```json
{
  "url": "http://smartforms.csiro.au/StructureDefinition/shl-write-descriptor",
  "extension": [
    { "url": "writeUrl", "valueUrl": "https://hapi.fhir.org/baseR4/QuestionnaireResponse/4821" },
    { "url": "writeMethod", "valueCode": "PUT" },
    { "url": "writeEtag", "valueString": "W/\"1\"" },
    { "url": "writeToken", "valueString": "…" },
    { "url": "expiresAt", "valueInteger": 1786000000 }
  ]
}
```

| Field | Card. | Meaning |
|---|---|---|
| `writeUrl` | 1..1 | Absolute `https` URL of the pre-allocated `QuestionnaireResponse`. Accept `valueUrl` or `valueString`. |
| `writeMethod` | 0..1 | `PUT` is the only value specified. Absent means `PUT`. |
| `writeEtag` | 0..1 | What to send in `If-Match`. Absent means unconditional — still a location, no longer a *single* write. |
| `writeToken` | 0..1 | Capability to perform the write, for hosts that gate them. Never a capability to *read* the slot. |
| `expiresAt` | 0..1 | Unix seconds. Mirrors the link's own `exp`. |

**The descriptor appears only inside the encrypted payload — never in the `shlink:` string**, and
never on any copy of the `Task` published to a server. The same rule, and the same reason, as channel
C's.

Parse tolerantly. Anything missing, malformed, or naming an address you may not contact means "this
invitation offers no write channel", not an error. Reject a `writeMethod` you do not implement rather
than attempting the write anyway.

**Be honest about `writeToken` where the host ignores it.** On a plain FHIR server it is advisory: it
is carried because it is the field a gating host needs, and having it in the format means such a host
requires no format change. It is not what makes the write single-use, and a UI that implies otherwise
is lying to someone about the protection they have.

### Delivering the answers

```
PUT {writeUrl}
If-Match: {writeEtag}
Authorization: Bearer {writeToken}      (only when the descriptor carries one)
Content-Type: application/fhir+json

{ "resourceType": "QuestionnaireResponse", "id": "4821", "status": "completed", … }
```

| Status | Meaning |
|---|---|
| `200`/`201` | Written. That was the one write the capability allowed. |
| `409`/`412` | Already answered — by an earlier send of yours, or by somebody else. **Do not retry.** Offer the filler another route instead. |
| `401`/`403` | The host gates writes and refused the token. |
| `404`/`410` | The slot is gone. A normal end state for an expired request. |

### The payload

A bare `QuestionnaireResponse`, not a Bundle: the capability addresses exactly one resource, so there
is nowhere to put a second one. Three consequences, each a deliberate trade:

- **`id` must equal the id in `writeUrl`.** A FHIR update requires it. This is the one channel where
  the filler *keeps* an id rather than stripping it — and it is not the filler's identity leaking, it
  is the address being written to. Every other rule about foreign ids still applies to the requester
  when it later writes to its own record.
- **No `Provenance`, so `meta.security` = `PATAST` carries the entire attribution story.** Stamp it
  whenever the answers were entered by the patient. Without it, answers typed on a phone are
  indistinguishable in the record from answers a clinician recorded.
- **No `Task` echo, so correlation moves onto `QuestionnaireResponse.identifier`.** R4 allows one,
  which is exactly enough for the request's `urn:uuid`. In practice the requester also knows *which
  slot* answered, so this is for a reader holding only the resource.

**`subject` carries a `display` and no `reference`.** This is not optional politeness. A filler names
the patient in its own terms — Platypus uses a local vault key — and that reference resolves nowhere.
On the requester's record server that is a reconciliation for a human; on the *slot* server it is a
hard `HAPI-1094` that fails the write outright and strands the answers. The name is what survives, and
the requester reconciles it against the patient it addressed the request to.

**Do not echo the descriptor back**, and in particular not `writeToken` — the same rule as channel C's.

### Collecting

```
GET {writeUrl}
Accept: application/fhir+json
```

Decide "answered" **structurally**, from `status` — `completed` or `amended` — rather than by
comparing against whatever placeholder the slot was minted with. A host is free to represent an
untouched slot however it likes, and a requester that recognised only its own placeholder would miss
an answer that arrived any other way. `404`/`410` means the slot is gone.

### Where the slot must live

**Not on the record server.** This is the single design decision that separates D from B, and
implementing D with the slot on the record server rebuilds B with extra steps.

A slot holds an unreviewed assertion from a party whose only credential is that they had a link. Mint
it on transport infrastructure of the same trust class as the SHL payload host — in this
implementation, `blobServerUrl` — so the requester collects it, shows it to a human, and only then
writes to the record. The honest cost, which must be stated to whoever turns this on: **the slot host
sees the answers in plaintext.** Channel C exists precisely so that cannot happen.

### Security model

- **Nothing is recoverable from the `shlink:` string.** No slot, no token, no ETag.
- **A leaked invitation can consume the write, and can read the answers if it is fast.** This is
  strictly weaker than channel C, where a leaked invitation can destroy a reply but never read one.
  It is the price of a channel a filler can implement without crypto, and it is why C is not being
  retired.
- **The write is bounded to one resource and one use.** A capability that leaks after it has been
  spent is worth nothing, and `expiresAt` bounds one that was never spent.
- **A requester must not trust what lands.** It arrives from an unauthenticated party who has the
  link, which is not proof of who filled the form. Review before writing, keep the `PATAST` label.

## Channel B — write to the requester's server

Two halves. On the embedded `Questionnaire`, SDC's standard
[`sdc-questionnaire-endpoint`](http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint):

```json
{ "url": "http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint",
  "valueUri": "https://ehr.example.org/fhir" }
```

*"the base URL for the server(s) to which questionnaire response … should be submitted. If multiple
repetitions are present, the completed form should be sent to all listed endpoints."*

And on the `Task`, its own absolute URL on that server, so the filler can advance it:

```json
{ "url": "http://smartforms.csiro.au/StructureDefinition/invitation-server-task-url",
  "valueUrl": "https://ehr.example.org/fhir/Task/456" }
```

> **Superseded by channel D.** Understand it, because invitations carrying it exist; do not offer it
> on anything new. Everything below that reads as a cost — an open endpoint, no capability, no way to
> be single-use, answers landing unreviewed — is fixed there.

The filler `POST`s the `QuestionnaireResponse` to the declared base and may `PUT` the Task to
`completed`. No token, no handshake — which is also the catch: **the endpoint must accept writes from
a party holding nothing but a link**, and answers arrive **unreviewed**.

The `Task` published to that server carries **no extensions**. Its invitation copy holds the reply
descriptor, including any `replyToken`; putting that on a server whose purpose is to be readable by a
filler would hand the write capability to anyone who can read a Task. Both copies share one
`identifier` so they stay correlatable.

## Security model

- **The reply channel lives only inside the encrypted payload.** No slot, token, or key is recoverable
  from a `shlink:` string.
- **Replies are readable only by the requester.** ECDH-ES to a public key whose private half never
  leaves the requester, so a leaked invitation cannot decrypt a reply.
- **A leaked invitation can destroy a reply, not read one.** With an ungated slot — a plain FHIR
  `Binary`, say — anyone who can reach the host can overwrite it, and on servers with sequential ids
  they need not even have seen the link. The reply is still ciphertext to them. `replyToken` exists for
  hosts that can narrow this; it needs no change to the wire format.
- **Channel B has no confidentiality story at all.** It is a plain write to a server that must accept
  anonymous writes. Use it where that is already true, and prefer channel C otherwise.
- **Channel D has confidentiality from everyone but the slot host,** and bounds the damage a leaked
  invitation can do to a single write that can only happen once. Its slot must be transport, not a
  record — see above.
- **A requester must not trust a reply.** It arrives from an unauthenticated party who has the link,
  which is not proof of who filled the form. Review before writing, keep the `PATAST` label, and keep
  the `Provenance`.

## Notes for implementers

- **Do not add query parameters to a `U`-flag payload `GET`.** The SHL spec defines `recipient` as a
  field in the *manifest request body*; there is no equivalent for direct retrieval. Appending it to
  the file URL breaks FHIR `Binary` hosting outright:

  ```
  GET .../Binary/137286897                            -> 200 application/jose
  GET .../Binary/137286897?recipient=Some%20App       -> 400 not-supported
       "The FHIR endpoint on this server does not know how to handle
        GET operation[Binary/137286897] with parameters [[recipient]]"
  ```

  That rules out the most obvious file host in FHIR for no benefit, since `recipient` is not relied on
  for trust.
- **Preserve `meta.security` when writing a received response.** Stripping `meta` wholesale to discard
  a foreign server's `versionId`/`lastUpdated`/`source` is correct in intent and takes the `PATAST`
  label with it. Strip those three fields, not the element.
- **Expect the subject not to resolve.** A response from a third-party filler names a patient in that
  app's terms. A server enforcing referential integrity rejects the whole write:
  `HAPI-1094: Resource Patient/x not found, specified in path: QuestionnaireResponse.subject`.
  Reconcile it with a human in the loop; do not silently drop `subject` to force the write through,
  which loses who the answers are about.
- **`https` only, and no loopback.** A payload or reply URL taken from an untrusted link should be
  required to be `https` and rejected if it resolves to localhost or a link-local address.
- **Verify the crypto against a second implementation.** A self-consistent implementation of the wrong
  Concat-KDF passes its own round trip perfectly and cannot talk to anyone.

## Relationship to Platypus

[Platypus](https://github.com/aehrc/platypus) shipped this contract first
(`docs/features/shl-form-invitations.md`) under its own identifiers, and its design decisions — the
`Task` extension, ECDH-ES to a practice key, `PATAST` plus `Provenance` on the reply — are adopted here
essentially unchanged. What differs is packaging:

| | Platypus | Here |
|---|---|---|
| Extension base | `https://platypushealth.app/StructureDefinition/` | `http://smartforms.csiro.au/StructureDefinition/` |
| Delivery | relay: register install → grant → signed `POST` | `PUT` to any host |
| `replyMethod` | absent | explicit, so the descriptor is host-neutral |
| Write token | `replyPostToken` | `replyToken` |

Channel D reverses the direction of that borrowing: it is specified here first, and Platypus reads it
under both namespaces. The relevant difference on their side is a trust rule rather than a wire one.
Platypus pins a channel-C `replyUrl` to its own relay origin, because redeeming a reply grant presents
*that install's* identity token and "safe to reach" is not "entitled to our identity". A channel-D
write presents only the capability the invitation itself supplied, which grants the host nothing it
did not already issue — so the applicable rule is the ordinary untrusted-URL one (`https`, no loopback
or link-local, re-classified per redirect hop), plus a confirmation naming the host.

Our implementation **reads** the Platypus URLs and the `replyPostToken` name as aliases, and treats an
untyped descriptor carrying a token as a relay rather than something to `PUT` at blindly. Read
tolerantly, write narrowly: no third party should have to adopt one vendor's namespace to participate.

The generalisation worth pursuing beyond this document is that a reply descriptor is functionally
*"where do answers go"* for an untrusted, account-less channel — the same question
`sdc-questionnaire-endpoint` already answers for trusted ones. Aligning the two, in SDC or the SHL IG,
would retire these extensions, which would be the best outcome available. Channel D is the closest of
the three to something SDC could absorb directly: strip the token and it is a conditional `PUT` to a
resource the requester nominated, which needs no new concepts at all — only a way to say the address
and the version.
