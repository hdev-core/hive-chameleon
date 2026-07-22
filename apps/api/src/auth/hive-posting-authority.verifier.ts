import { createHash } from 'node:crypto';

import { validateHiveCompactSignature, WaxHiveChainAdapter } from '@hive-chameleon/hive-gateway';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

import type { AuthConfig } from './auth.config';
import type { HivePostingAuthorityVerifier } from './auth.types';

const authoritySchema = z.strictObject({
  account_auths: z.array(z.tuple([z.string(), z.number().int().positive()])),
  key_auths: z.array(z.tuple([z.string(), z.number().int().positive()])),
  weight_threshold: z.number().int().positive(),
});
const hiveAccountSchema = z.object({ name: z.string(), posting: authoritySchema });
const rpcResponseSchema = z.object({ result: z.array(hiveAccountSchema) });

@Injectable()
export class RpcHivePostingAuthorityVerifier implements HivePostingAuthorityVerifier {
  private readonly chain: WaxHiveChainAdapter;

  public constructor(private readonly config: AuthConfig) {
    this.chain = new WaxHiveChainAdapter({
      apiEndpoint: config.hiveRpcUrl,
      chainId: config.hiveChainId,
    });
  }

  public async verify(input: {
    readonly challenge: string;
    readonly hiveUsername: string;
    readonly signature: string;
  }): Promise<boolean> {
    try {
      validateHiveCompactSignature(input.signature);
      const digest = createHash('sha256').update(input.challenge, 'utf8').digest('hex');
      const recoveredKey = await this.chain.recoverPublicKey(digest, input.signature);
      return this.keyCanSatisfyPostingAuthority(input.hiveUsername, recoveredKey, new Set(), 0);
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      return false;
    }
  }

  public async usernameExists(hiveUsername: string): Promise<boolean> {
    return (await this.fetchAccount(hiveUsername)) !== null;
  }

  private async keyCanSatisfyPostingAuthority(
    accountName: string,
    recoveredKey: string,
    visited: ReadonlySet<string>,
    depth: number,
  ): Promise<boolean> {
    if (visited.has(accountName) || depth > 2) {
      return false;
    }
    const account = await this.fetchAccount(accountName);
    if (!account) {
      return false;
    }
    const directWeight = account.posting.key_auths
      .filter(([key]) => key === recoveredKey)
      .reduce((sum, [, weight]) => sum + weight, 0);
    if (directWeight >= account.posting.weight_threshold) {
      return true;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(accountName);
    for (const [nestedAccount, outerWeight] of account.posting.account_auths) {
      if (
        outerWeight >= account.posting.weight_threshold &&
        (await this.keyCanSatisfyPostingAuthority(
          nestedAccount,
          recoveredKey,
          nextVisited,
          depth + 1,
        ))
      ) {
        return true;
      }
    }
    return false;
  }

  private async fetchAccount(
    accountName: string,
  ): Promise<z.infer<typeof hiveAccountSchema> | null> {
    let response: Response;
    try {
      response = await fetch(this.config.hiveRpcUrl, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'condenser_api.get_accounts',
          params: [[accountName]],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw hiveUnavailable();
    }
    if (!response.ok) {
      throw hiveUnavailable();
    }
    const parsed = rpcResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw hiveUnavailable();
    }
    return parsed.data.result[0] ?? null;
  }
}

function hiveUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'hive_unavailable',
    detail:
      'Hive account authority could not be verified. Retry without reusing the old challenge.',
    status: 503,
    title: 'Hive unavailable',
  });
}
