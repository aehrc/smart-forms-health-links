# ⚠️ Known defect: the links we mint are unreachable to conformant receivers

**Status:** open, unfixed. Worked around *in the receiver*, not here.
**Discovered:** 2026-08-05, testing interop with [Platypus Health](https://github.com/aehrc/platypus).
**Severity:** every `U`-flag link this app mints is unopenable by any third-party SHL app that
follows the specification. Our own viewer is unaffected, which is exactly why this went unnoticed.

## The symptom

A link that opens perfectly in our own `/view` route fails in another SHL wallet with an HTTP `400`
before the payload is ever fetched:

```
GET https://proxy.smartforms.io/fhir/Binary/4343                            → 200  application/jose  ✅
GET https://proxy.smartforms.io/fhir/Binary/4343?recipient=Platypus%20Health → 400  OperationOutcome  ❌

  "Invalid request: The FHIR endpoint on this server does not know how to handle
   GET operation[Binary/4343] with parameters [[recipient]]"
```

Nothing is wrong with the link. The payload decrypts, and the Bundle inside it is exactly what the
receiver expects. The file simply cannot be retrieved the way the specification says to retrieve it.

## The root cause

The [SHL specification](https://docs.smarthealthit.org/smart-health-links/spec/) makes `recipient` a
**required** query parameter on the `U`-flag `GET`:

> the application SHALL retrieve a SHLink's sole encrypted file by issuing a request to the `url`
> with: Method: `GET`, Query parameters `recipient`: Required.

So a conformant receiver *must* send it. `fhirBinaryBlobStore` parks the JWE on a HAPI FHIR
`Binary`, and HAPI rejects unrecognised query parameters on a read rather than ignoring them. The
two requirements are simply incompatible: **a FHIR `Binary` endpoint cannot host a conformant
`U`-flag payload.**

The note in `src/fhir/blobStore.ts` claiming the `Binary` read behaviour "is exactly the behaviour
the SHL `U` flag needs" is what made this invisible. It verified the right thing (that a bare `GET`
returns raw bytes rather than a resource wrapper) and never tested the request a receiver actually
makes.

Our own viewer works only by accident: `fetchJwe` in `src/link/shlCodec.ts` sends no `recipient` at
all. That is the same defect facing the other way, and it is the second half of the fix.

## This is ours to fix, not the receiver's

Worth stating plainly, because the failure surfaces in someone else's app. The receiver is doing
what the spec requires; we are publishing to a host that cannot serve it. Any wallet, not just
Platypus, hits this.

## What has to change

The `BlobStore` interface already anticipated this ("today a FHIR `Binary` on the forms server,
tomorrow an S3 bucket or a real SHL manifest server"). The work is to take that second option.

1. **A blob store whose URLs tolerate extra query parameters.** Add an implementation alongside
   `fhirBinaryBlobStore` in `src/fhir/blobStore.ts`. The bar is low and has nothing to do with FHIR:
   a `GET` must return the stored bytes and ignore anything it does not recognise in the query
   string. A static object host (S3 or equivalent) does this by default. So does Platypus's own SHL
   relay (`apps/shl-lambda` in that repo), which serves both Tier-1 objects and Tier-2 manifests and
   would give us the tightest interop loop for testing.

2. **Correct the misleading comment** on `fhirBinaryBlobStore` in the same file. Whether we keep
   that store at all is a judgement call: it is genuinely useful for local development against a
   sandbox FHIR server, but it must say that what it produces is *not* a conformant `U`-flag host.

3. **Config.** `blobStore` is a single-member union (`src/lib/config.ts:58`) validated by an equality
   check (`src/lib/config.ts:184`); both need the new variant, and the new store needs its own base
   URL rather than reusing `blobServerUrl`, whose documented meaning is a FHIR server.

4. **Send `recipient` when we read.** `fetchJwe` in `src/link/shlCodec.ts` omits it, which is
   non-conformant and will fail against a host that requires it. Reuse the existing `RECIPIENT`
   constant and `DecodeOptions.recipient`, which the manifest path already threads through. Keep the
   existing no-`Accept`-header comment; it is correct and for an unrelated reason.

5. **The test shims break when step 4 lands.** `scripts/roundtrip.ts` serves the in-memory store
   through a fetch shim keyed on an exact URL match (`scripts/roundtrip.ts:255`, and the same
   pattern again at 391 and 1069). A `?recipient=…` suffix will miss the lookup and fall through to
   the real network. Strip the query string before the lookup, and add a case asserting that the
   parameter is sent, so this cannot regress.

6. **A `U`-flag interop check in `npm run check:e2e`.** The gap here was never a missing unit test,
   it was that nothing ever issued the request a spec-conformant receiver issues. A check that
   fetches a freshly minted link's `url` *with* `recipient` appended would have caught it on day one.

7. **Update the README.** The "Two transports, one interface" section describes `U`-flag hosting as
   needing "only a file host"; that is true but underspecified, since a FHIR `Binary` looks like a
   file host and is not one for this purpose.

## What to undo elsewhere once this is fixed

Platypus carries a workaround that exists only because of this defect, and it should come out when
the defect goes:

- `packages/shl-parser/src/shl-parser.ts` → `fetchDirectFile` retries the `GET` once without
  `recipient` after a `400`. The comment there points back at this document. Its tests
  (`retries the direct GET without the recipient param…` and the two beside it) come out with it.
- The `CHANGELOG.md` entry under `[Unreleased] → Fixed` describing that retry.

Leaving the workaround in place is not harmful (it drops a self-declared audit string a hostile host
could ignore anyway) but it is receiver-side tolerance for a bug that will have stopped existing,
and tolerance nobody removes becomes tolerance nobody understands.

## When to come back to this

Any of these, whichever comes first:

- **Before any third party is asked to open one of our links.** A demo, a connectathon, a pilot: the
  links are broken for everyone but us, so this blocks all of it.
- **When object hosting is stood up for any other reason.** The reply channel
  ([`shl-form-reply-channel.md`](shl-form-reply-channel.md)) wants somewhere to park encrypted
  replies; whatever is chosen there almost certainly solves this too, and doing both at once is
  cheaper than doing either alone.
- **Before `enableServerReturn` or the encrypted reply channel is turned on by default.** Both make
  the app's links load-bearing for a real workflow rather than a demo.

If passcodes or revocation are ever wanted, note that the answer is the same infrastructure: a
Tier-2 manifest host, which brings `P`-flag support and per-recipient control that `U` structurally
cannot have.
