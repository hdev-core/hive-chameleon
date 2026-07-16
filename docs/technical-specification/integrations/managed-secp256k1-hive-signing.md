# Managed secp256k1 signatures for Hive

- **Status:** Validated conversion recipe and sanitized proof record
- **Scope:** DER-encoded ECDSA signatures returned by a managed secp256k1 signer
- **Production decision:** Cryptographic compatibility passed; the custody provider and key
  topology remain unselected

## 1. Purpose

Hive expects a recoverable 65-byte Graphene compact signature, while managed signers commonly
return an ASN.1 DER ECDSA signature containing only `(r, s)`. This note records the conversion
that worked against Hive without exporting the private key.

WAX remains responsible for operation construction, HF26 serialization, and the transaction
signature digest. The custody adapter performs only the provider call and the conversion below;
it must not serialize the transaction independently.

Low-S normalization and Graphene compact canonicality are separate requirements:

- **Low-S** chooses the non-malleable ECDSA representative `s <= n / 2`.
- **Compact canonicality** constrains the leading bytes of the fixed-width `r` and `s` fields.

A low-S signature can still fail the compact-canonical byte rules and require a fresh provider
signature over the same digest.

## 2. Inputs and signer contract

The conversion requires:

- `digest`: the exact 32-byte WAX `sigDigest` for the transaction;
- `der`: a strict DER-encoded secp256k1 ECDSA signature over `digest`; and
- `expectedPublicKey`: the signer's 33-byte compressed secp256k1 public key.

The secp256k1 group order is:

```text
n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
```

The signer must treat the supplied bytes as an already-computed digest and must not hash them
again. For the validated AWS KMS path, the key was `ECC_SECG_P256K1` with `SIGN_VERIFY` usage
and the call used:

```text
Message          = digest
MessageType      = DIGEST
SigningAlgorithm = ECDSA_SHA_256
```

`ECDSA_SHA_256` names the KMS signing algorithm; `MessageType=DIGEST` prevents KMS from hashing
the WAX digest again. A provider adapter must establish the equivalent behavior for any other
signer.

## 3. Conversion recipe

### 3.1 Parse and normalize

1. Require a 32-byte digest and a valid 33-byte compressed public key.
2. Parse DER strictly and require `1 <= r < n` and `1 <= s < n`. DER integers are variable
   width; do not copy their encoded bytes directly into the compact signature.
3. Normalize `s` before deriving the recovery ID:

```text
sLow = s                    when s <= floor(n / 2)
sLow = n - s                when s >  floor(n / 2)
```

4. Verify `(r, sLow)` over the existing digest against `expectedPublicKey`, with library
   prehashing disabled. Fail closed if verification fails.

Normalizing first matters. Replacing `s` with `n - s` preserves ECDSA validity but changes the
recovery point's parity, so a recovery ID derived from the original high-S pair may be wrong for
the emitted low-S pair.

### 3.2 Derive the recovery ID

The DER signature does not carry a recovery ID. Try all secp256k1 recovery candidates `0..3`
against the normalized `(r, sLow)`:

```text
for recoveryId in [0, 1, 2, 3]:
    recovered = recoverPublicKey(digest, r, sLow, recoveryId)
    if compress(recovered) == expectedPublicKey:
        select recoveryId
```

Invalid recovery candidates are skipped. Refuse the signature if none recovers the exact
expected compressed key; never guess the parity or assume the ID is limited to `0` and `1`.

Mathematically, a candidate ID chooses an `R` point whose x-coordinate is `r + jn` and whose
y-coordinate has the selected parity. The candidate public key is then:

```text
Q = r^-1 (sLow * R - z * G)
```

where `z` is the digest interpreted according to ECDSA, `G` is the secp256k1 generator, and
`j = recoveryId >> 1`. In implementation, use a maintained secp256k1 recovery primitive and
compare the resulting compressed bytes with the provider key.

### 3.3 Assemble Hive's 65-byte form

Encode both scalars as unsigned, fixed-width, 32-byte big-endian values. Hive's compact header
adds Graphene's base value `27`, the compressed-key flag `4`, and the recovery ID:

```text
header      = 27 + 4 + recoveryId
signature65 = byte(header) || I2OSP(r, 32) || I2OSP(sLow, 32)
```

The result has this exact layout:

| Offset |   Length | Value                                  |
| -----: | -------: | -------------------------------------- |
|    `0` |   1 byte | Header `31..34` (`0x1f..0x22`)         |
|    `1` | 32 bytes | `r`, unsigned big-endian               |
|   `33` | 32 bytes | normalized `sLow`, unsigned big-endian |

The binary value must be exactly 65 bytes. Its hexadecimal representation is exactly 130
characters without a `0x` prefix. A library's ordinary 64-byte “compact” result is only
`r || s`; it is not yet a Hive signature.

### 3.4 Enforce Graphene compact canonicality

Apply this predicate independently to the 32-byte `r` and `sLow` fields:

```text
canonicalScalar(x):
    (x[0] & 0x80) == 0
    and not (x[0] == 0 and (x[1] & 0x80) == 0)
```

Equivalently, for the assembled signature, check bytes `1`/`2` for `r` and bytes `33`/`34`
for `sLow`. This rejects values that would look negative as signed integers and values with a
redundant leading zero.

If either field fails, discard that attempt and ask the managed signer for a new signature over
the same digest. The provider controls the ECDSA nonce, so the adapter cannot repair `r` or
arbitrarily change `sLow`. Use a bounded retry count and report exhaustion as a signing failure;
the validation implementation used a limit of ten attempts.

## 4. Reference flow

```text
repeat up to MAX_ATTEMPTS:
    der = managedSigner.signDigest(digest)
    (r, s) = parseStrictDer(der)
    sLow = min(s, n - s)

    require verifyNoPrehash(expectedPublicKey, digest, r, sLow)

    recoveryId = find id in 0..3 where
        compress(recoverPublicKey(digest, r, sLow, id)) == expectedPublicKey
    require recoveryId exists

    signature65 = byte(31 + recoveryId) || u256be(r) || u256be(sLow)
    if not grapheneCompactCanonical(signature65):
        continue

    require waxRecover(digest, signature65) == expected Hive public key
    return signature65

fail: canonical signature not produced within MAX_ATTEMPTS
```

Before returning, the production adapter must satisfy all of these gates:

1. strict DER and scalar-range validation;
2. local secp256k1 verification over the unmodified digest;
3. low-S normalization;
4. recovery of the expected compressed provider key;
5. exactly 65 bytes with the compressed Graphene header;
6. Graphene compact-canonical `r` and `s` bytes; and
7. WAX recovery of the expected Hive public key.

Any mismatch is a hard failure. In particular, do not attach the DER bytes, retry with a
different digest, accept a merely verifying but unexpected recovered key, or fall back to a
service key.

## 5. Sanitized validation record

On 2026-07-14, an AWS KMS `ECC_SECG_P256K1` key in `eu-central-1` signed a WAX transaction
digest. WAX 2.0.2 recovered the expected key, a Hive node accepted the posting-authority
`custom_json`, and the transaction reached irreversibility.

| Field                | Recorded value                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Digest               | `23b62f08f440d24db93bbd61e1a902b9807ce6d4d3a63be80569575651699234`                                                                   |
| Compact signature    | `204486a65bbc34a4d7cacf14ca4fb255ba31a0620ffa9cbd1d1546c8ea839b9abe0f4949c525dbd7105f61d7176348a8a7df68dff90b49b7e58a5660906620f856` |
| Header / recovery ID | `0x20` / `1`                                                                                                                         |
| Recovered Hive key   | `STM7u41yX66A2r6JNBrgawxT51sPxRMTJAW1QaEwdxQfFePGvCDET`                                                                              |
| Transaction          | `232d35d6df16a7d32ff9a5ead11aeb2867e3ef18`                                                                                           |
| Irreversible block   | `108123370`                                                                                                                          |
| Provider attempts    | `3` (`2` compact-canonical retries)                                                                                                  |

The benchmark produced 1,000 accepted signatures from 1,984 KMS signing calls, with 984
compact-canonical retries, 1,000 high-S normalizations across all attempts, no signing errors,
and accepted recovery IDs split between `0` and `1`. These measurements demonstrate why both
normalization and bounded canonical retries belong in the adapter; they are not production
latency or capacity guarantees.

## 6. Decision boundary

The proof establishes only the managed-signature conversion and end-to-end Hive compatibility.
It does not select AWS KMS as the production custody provider. One native managed key per Hive
authority per player did not pass the broader cost, scale, and memo-key capability gate, so the
provider-neutral custody selection in the
[third-party integration register](./third-party-integration-register.md) remains open.

Hetzner is the selected application host, but that hosting decision does not select or constrain
the custody backend. Standard HashiCorp Vault Transit is not a drop-in alternative because its
documented ECDSA key types do not include secp256k1. A custom Vault plugin, managed-key service,
or HSM integration is a distinct provider design and must pass the same production gates.

Whichever provider is selected must preserve this recipe's inputs and verification gates while
also meeting the project's non-exportability, per-key authorization, destruction evidence,
scaling, and optional memo shared-secret requirements.
