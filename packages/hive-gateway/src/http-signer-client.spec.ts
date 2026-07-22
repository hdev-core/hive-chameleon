import { describe, expect, it, vi } from 'vitest';

import { MATCH_INTENT_FIXTURE } from './testing/fixtures.js';
import { HttpIsolatedSignerClient } from './http-signer-client.js';

const request = {
  idempotencyKey: MATCH_INTENT_FIXTURE.idempotencyKey,
  policyVersion: 'match-policy-1',
  role: 'match_publisher',
  account: 'match-pub',
  authority: 'posting',
  expectedPublicKey: 'STM7u41yX66A2r6JNBrgawxT51sPxRMTJAW1QaEwdxQfFePGvCDET',
  signerKeyReference: 'fixture/match-publisher/posting',
  eventFamily: 'match',
  eventType: 'match_results_batch',
  canonicalPayload: '{}',
  canonicalOperationJson: '{}',
  canonicalOperationHash: 'a'.repeat(64),
  unsignedTransactionJson: '{}',
  signatureDigest: 'b'.repeat(64),
  transactionId: 'c'.repeat(40),
} as const;

describe('HttpIsolatedSignerClient', () => {
  it('posts the complete request once with bearer authentication', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ signature: 'd'.repeat(130), publicKey: request.expectedPublicKey }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const client = new HttpIsolatedSignerClient({
      endpoint: 'https://signer.internal.example/v1/sign',
      bearerToken: 'fixture-token-that-is-at-least-32-characters',
      fetchImplementation,
    });

    await expect(client.sign(request)).resolves.toEqual({
      signature: 'd'.repeat(130),
      publicKey: request.expectedPublicKey,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe('https://signer.internal.example/v1/sign');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer fixture-token-that-is-at-least-32-characters',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it('fails closed for insecure endpoints and malformed responses', async () => {
    expect(
      () =>
        new HttpIsolatedSignerClient({
          endpoint: 'http://signer.internal.example/v1/sign',
          bearerToken: 'fixture-token-that-is-at-least-32-characters',
        }),
    ).toThrow(/must be HTTPS/);

    const client = new HttpIsolatedSignerClient({
      endpoint: 'https://signer.internal.example/v1/sign',
      bearerToken: 'fixture-token-that-is-at-least-32-characters',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ signature: 'too-short', publicKey: 'also-short' }), {
          status: 200,
        }),
      ),
    });
    await expect(client.sign(request)).rejects.toMatchObject({ code: 'signer_mismatch' });
  });
});
