import type { HiveChainPort } from './contracts.js';
import { HiveGatewayError } from './errors.js';

const SECP256K1_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

export interface HiveCompactSignatureInfo {
  readonly recoveryId: number;
  readonly r: string;
  readonly s: string;
}

export function validateHiveCompactSignature(signature: string): HiveCompactSignatureInfo {
  if (!/^[0-9a-f]{130}$/.test(signature)) {
    throw new HiveGatewayError(
      'invalid_signature',
      'Hive compact signature must be exactly 65 lowercase hexadecimal bytes',
    );
  }

  const header = Number.parseInt(signature.slice(0, 2), 16);
  if (header < 31 || header > 34) {
    throw new HiveGatewayError('invalid_signature', 'Hive compact signature header is invalid');
  }

  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);
  if (!isGrapheneCanonicalScalar(r) || !isGrapheneCanonicalScalar(s)) {
    throw new HiveGatewayError(
      'invalid_signature',
      'Hive signature scalars are not compact-canonical',
    );
  }

  const sValue = BigInt(`0x${s}`);
  if (sValue < 1n || sValue > SECP256K1_HALF_ORDER) {
    throw new HiveGatewayError('invalid_signature', 'Hive signature is not normalized to low-S');
  }

  return { recoveryId: header - 31, r, s };
}

export async function assertSignatureMatchesPublicKey(
  chain: HiveChainPort,
  signatureDigest: string,
  signature: string,
  expectedPublicKey: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(signatureDigest)) {
    throw new HiveGatewayError(
      'invalid_signature',
      'Signature digest must be 32 lowercase hex bytes',
    );
  }

  validateHiveCompactSignature(signature);
  const recovered = await chain.recoverPublicKey(signatureDigest, signature);
  if (recovered !== expectedPublicKey) {
    throw new HiveGatewayError(
      'signer_mismatch',
      'Signature did not recover the expected Hive public key',
    );
  }
}

function isGrapheneCanonicalScalar(hex: string): boolean {
  const first = Number.parseInt(hex.slice(0, 2), 16);
  const second = Number.parseInt(hex.slice(2, 4), 16);
  return (first & 0x80) === 0 && !(first === 0 && (second & 0x80) === 0);
}
