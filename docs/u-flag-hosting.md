# U-flag hosting: the defect, and the half of it that remains

**Status:** the outbound half is **closed**. It was closed by moving hosting into this app's own
server rather than by fixing the blob store, so the fix is architectural and the reasoning below is
kept as the record of why. The inbound half is **open**.
**Discovered:** 2026-08-05, testing interop with [Platypus Health](https://github.com/aehrc/platypus).
**Severity, as it stood:** every `U`-flag link this app minted was unopenable by any third-party SHL
app that follows the specification. Our own viewer was unaffected, which is exactly why it went
unnoticed.

## The symptom

A link that opened perfectly in our own `/view` route failed in another SHL wallet with an HTTP `400`
before the payload was ever fetched:

```
GET https://proxy.smartforms.io/fhir/Binary/4343                             -> 200  application/jose
GET https://proxy.smartforms.io/fhir/Binary/4343?recipient=Platypus%20Health -> 400  OperationOutcome

  "Invalid request: The FHIR endpoint on this server does not know how to handle
   GET operation[Binary/4343] with parameters [[recipient]]"
```

Nothing was wrong with the link. The payload decrypted, and the Bundle inside it was exactly what the
receiver expected. The file simply could not be retrieved the way the specification says to retrieve
it.

## The root cause

The [SHL specification](https://docs.smarthealthit.org/smart-health-links/spec/) makes `recipient` a
**required** query parameter on the `U`-flag `GET`:

> the application SHALL retrieve a SHLink's sole encrypted file by issuing a request to the `url`
> with: Method: `GET`, Query parameters `recipient`: Required.

So a conformant receiver _must_ send it. The blob store parked the JWE on a HAPI FHIR `Binary`, and
HAPI rejects unrecognised query parameters on a read rather than ignoring them. The two requirements
are simply incompatible: **a FHIR `Binary` endpoint cannot host a conformant `U`-flag payload.**

A note in the blob store claiming the `Binary` read behaviour "is exactly the behaviour the SHL `U`
flag needs" is what made this invisible. It verified the right thing - that a bare `GET` returns raw
bytes rather than a resource wrapper - and never tested the request a receiver actually makes.

Our own viewer worked only by accident: `fetchJwe` in `src/link/shlCodec.ts` sends no `recipient` at
all. That is the same defect facing the other way, and it is the half that is still open.

## What closed the outbound half

Not the fix this document originally proposed. The proposal was to stand up a blob store whose URLs
tolerate extra query parameters - an object host, or Platypus's own SHL relay - and keep minting
`U`-flag links against it.

What happened instead is that the app became a
[confidential SMART app](../README.md#what-this-demonstrates) with a server-side component of its
own, and hosting moved into that. Three consequences retire the defect rather than fixing it:

- **The app no longer mints `U`-flag links.** Invitations are manifest-mode with no flag at all,
  because a manifest is the only mode that can carry two files and a token minted at fetch time.
  `recipient` is a field of the manifest request _body_, which the app has always sent, and there is
  no query string to be rejected.
- **The host is ours.** `POST /shl/:id` is a route on the same process that mints, so there is no
  third-party server whose parameter handling has to be accommodated. `recipient` is accepted because
  the specification defines it, and discarded unread.
- **No FHIR `Binary` is involved anywhere.** The blob store, its `Location`-header workaround and its
  misleading comment are all gone.

The one property the original proposal wanted and this does not deliver is a blind host: the server
keeps each link key so it can encrypt a grant file at fetch time. That trade is recorded in
[Known limitations](../README.md#known-limitations).

## What remains open

**We still do not send `recipient` when reading somebody else's `U`-flag link.** `fetchJwe` in
`src/link/shlCodec.ts` omits it, which is non-conformant and will fail against a host that requires
it. Two things to do, and they have to land together:

1. **Send it.** Reuse the existing `RECIPIENT` constant and `DecodeOptions.recipient`, which the
   manifest path already threads through. Keep the existing no-`Accept`-header comment; it is correct
   and for an unrelated reason.
2. **Fix the test shims.** `scripts/roundtrip.ts` serves its in-memory store through a fetch shim
   keyed on an exact URL match. A `?recipient=…` suffix will miss the lookup and fall through to the
   real network. Strip the query string before the lookup, and add a case asserting the parameter is
   sent, so this cannot regress.

This is a lower-severity gap than the one that closed. It costs nothing today, because the hosts this
app reads from - its own manifest route, and the file hosts Platypus uses - do not require the
parameter. It will cost something the first time a conformant object host is on the other end.

## What to undo elsewhere

Platypus carries a workaround that exists because of the outbound half:

- `packages/shl-parser/src/shl-parser.ts` -> `fetchDirectFile` retries the `GET` once without
  `recipient` after a `400`. The comment there points back at this document. Its tests come out with
  it, along with the `CHANGELOG.md` entry under `[Unreleased] -> Fixed` describing the retry.

Whether to remove it now is a judgement call, and the answer is probably not yet. Links this app
mints no longer trip it, but the workaround is tolerance for a class of host rather than for one
producer, and other producers still park payloads on FHIR `Binary` endpoints. Removing it would be
right once nobody it might rescue is still minting.

## Where the remaining infrastructure argument went

The original document said the same infrastructure that fixed this would bring passcodes and
revocation, which `U` structurally cannot have. That turned out to be true and it arrived for free:
manifest mode makes both structurally possible. Revocation and expiry are implemented - an invitation
row can be gone or expired, and both answer an identical `404`. A passcode is not, but nothing stands
in the way of one now.
