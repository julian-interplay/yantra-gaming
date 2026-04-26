import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret, encryptSecret } from '../utils/secrets.js';

// ──────────────────────────────────────────────────────────────────────────
// Per-operator asymmetric signing keys for launch JWTs.
//
// Why asymmetric:
//   * Operators publishing launch URLs to 3rd-party aggregators don't
//     want to hand out their HMAC secret. With ES256/RS256 they get a
//     public key that aggregators can verify with, while we alone sign.
//   * Standardised discovery via JWKS (/v1/.well-known/jwks.json) matches
//     every mainstream RGS integration contract.
//
// Key lifecycle:
//   ACTIVE    — signs new tokens.
//   RETIRING  — still verifies; no new signing.
//   RETIRED   — JWKS stops advertising; verification rejects.
//
// Keys are generated on-demand: the first call to `getActiveSigningKey`
// for an operator mints an ES256 pair if none exists. Private keys are
// AES-GCM-encrypted at rest (same master key as operator secrets).
//
// We keep HMAC (session-auth.ts signSessionToken) as the legacy path so
// in-flight deployments keep working; this module is additive.

export type SigningAlgorithm = 'ES256' | 'RS256';

interface Jwk {
  kty: string;
  use?: string;
  alg?: string;
  kid: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// Generate an ES256 (P-256) pair as public + private JWK objects.
function generateEs256Pair(kid: string): { publicJwk: Jwk; privateJwk: Jwk } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const pubJwk = publicKey.export({ format: 'jwk' }) as unknown as Jwk;
  const privJwk = privateKey.export({ format: 'jwk' }) as unknown as Jwk;
  return {
    publicJwk: {
      kty: pubJwk.kty ?? 'EC',
      use: 'sig',
      alg: 'ES256',
      kid,
      crv: pubJwk.crv,
      x: pubJwk.x,
      y: pubJwk.y,
    },
    privateJwk: {
      ...privJwk,
      kid,
      alg: 'ES256',
      use: 'sig',
    },
  };
}

export interface PublicJwk extends Jwk {}

export async function getActiveSigningKey(
  operatorId: string,
  algorithm: SigningAlgorithm = 'ES256',
): Promise<{ id: string; kid: string; privateJwk: Jwk; algorithm: SigningAlgorithm }> {
  const existing = await prisma.operatorSigningKey.findFirst({
    where: {
      operatorId,
      status: 'ACTIVE',
      OR: [{ notAfter: null }, { notAfter: { gt: new Date() } }],
      algorithm,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    const privateJwk = JSON.parse(
      decryptSecret(Buffer.from(existing.privateJwkCipher)),
    ) as Jwk;
    return {
      id: existing.id,
      kid: existing.kid,
      privateJwk,
      algorithm: existing.algorithm as SigningAlgorithm,
    };
  }

  // Mint a new key on demand.
  const kid = `osk_${crypto.randomBytes(8).toString('hex')}`;
  const pair =
    algorithm === 'ES256'
      ? generateEs256Pair(kid)
      : (() => {
          // Fallback RS256 — generate a 2048-bit RSA key.
          const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
          });
          const pub = publicKey.export({ format: 'jwk' }) as unknown as Jwk;
          const priv = privateKey.export({ format: 'jwk' }) as unknown as Jwk;
          return {
            publicJwk: { ...pub, kid, alg: 'RS256', use: 'sig' },
            privateJwk: { ...priv, kid, alg: 'RS256', use: 'sig' },
          };
        })();

  const row = await prisma.operatorSigningKey.create({
    data: {
      operatorId,
      kid,
      algorithm,
      publicJwk: pair.publicJwk as unknown as object,
      privateJwkCipher: encryptSecret(JSON.stringify(pair.privateJwk)),
    },
  });
  logger.info('operator_signing_key_minted', {
    operatorId,
    kid,
    algorithm,
  });
  return {
    id: row.id,
    kid,
    privateJwk: pair.privateJwk,
    algorithm,
  };
}

/** Rotate: mark current ACTIVE as RETIRING with notAfter = now+grace, mint new ACTIVE. */
export async function rotateSigningKey(
  operatorId: string,
  algorithm: SigningAlgorithm = 'ES256',
  graceMs: number = 24 * 60 * 60_000,
): Promise<{ newKid: string; previousKid: string | null }> {
  return prisma.$transaction(async (tx) => {
    const active = await tx.operatorSigningKey.findFirst({
      where: { operatorId, status: 'ACTIVE', algorithm },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      await tx.operatorSigningKey.update({
        where: { id: active.id },
        data: { status: 'RETIRING', notAfter: new Date(Date.now() + graceMs) },
      });
    }

    const kid = `osk_${crypto.randomBytes(8).toString('hex')}`;
    const pair = generateEs256Pair(kid);
    await tx.operatorSigningKey.create({
      data: {
        operatorId,
        kid,
        algorithm,
        publicJwk: pair.publicJwk as unknown as object,
        privateJwkCipher: encryptSecret(JSON.stringify(pair.privateJwk)),
      },
    });
    logger.info('operator_signing_key_rotated', {
      operatorId,
      newKid: kid,
      previousKid: active?.kid ?? null,
      graceMs,
    });
    return { newKid: kid, previousKid: active?.kid ?? null };
  });
}

export async function listPublicJwks(operatorId: string): Promise<{ keys: PublicJwk[] }> {
  const rows = await prisma.operatorSigningKey.findMany({
    where: {
      operatorId,
      status: { in: ['ACTIVE', 'RETIRING'] },
      OR: [{ notAfter: null }, { notAfter: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
  });
  return {
    keys: rows.map((r) => {
      const jwk = r.publicJwk as unknown as Jwk;
      return {
        ...jwk,
        kid: r.kid,
        alg: r.algorithm,
        use: 'sig',
      };
    }),
  };
}

// ── JWT signing/verification (ES256 only for v1) ─────────────

function b64urlJson(obj: unknown): string {
  return toBase64Url(Buffer.from(JSON.stringify(obj)));
}

function jwkToPrivateKey(jwk: Jwk): crypto.KeyObject {
  return crypto.createPrivateKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
}

function jwkToPublicKey(jwk: Jwk): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
}

/** ECDSA P-256 signature is DER in Node; JWT wants raw (r||s). */
function derToJose(der: Buffer): Buffer {
  // Minimal DER parser for SEQUENCE { INTEGER r, INTEGER s }
  if (der[0] !== 0x30) throw new Error('invalid_der');
  const rLen = der[3]!;
  const rOffset = 4;
  const sLen = der[rOffset + rLen + 1]!;
  const sOffset = rOffset + rLen + 2;
  let r = der.subarray(rOffset, rOffset + rLen);
  let s = der.subarray(sOffset, sOffset + sLen);
  // Strip leading zero bytes or left-pad to 32.
  if (r[0] === 0x00 && r.length > 32) r = r.subarray(1);
  if (s[0] === 0x00 && s.length > 32) s = s.subarray(1);
  const R = Buffer.alloc(32); r.copy(R, 32 - r.length);
  const S = Buffer.alloc(32); s.copy(S, 32 - s.length);
  return Buffer.concat([R, S]);
}

function joseToDer(jose: Buffer): Buffer {
  if (jose.length !== 64) throw new Error('invalid_jose_sig');
  const r = jose.subarray(0, 32);
  const s = jose.subarray(32);
  const rInt = addLeadingZeroIfHighBit(r);
  const sInt = addLeadingZeroIfHighBit(s);
  const seqBody = Buffer.concat([
    Buffer.from([0x02, rInt.length]),
    rInt,
    Buffer.from([0x02, sInt.length]),
    sInt,
  ]);
  return Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
}

function addLeadingZeroIfHighBit(buf: Buffer): Buffer {
  return buf[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
}

export async function signLaunchJwt(args: {
  operatorId: string;
  payload: Record<string, unknown>;
  expiresInSec: number;
}): Promise<string> {
  const key = await getActiveSigningKey(args.operatorId, 'ES256');
  const header = { alg: key.algorithm, typ: 'JWT', kid: key.kid };
  const iat = Math.floor(Date.now() / 1000);
  const claims = { ...args.payload, iat, exp: iat + args.expiresInSec };
  const headerB64 = b64urlJson(header);
  const payloadB64 = b64urlJson(claims);
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = jwkToPrivateKey(key.privateJwk);
  const derSig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'der',
  });
  const joseSig = derToJose(derSig);
  return `${signingInput}.${toBase64Url(joseSig)}`;
}

export async function verifyLaunchJwt(
  operatorId: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: { alg: string; kid: string };
  try {
    header = JSON.parse(fromBase64Url(h!).toString('utf8'));
  } catch {
    return null;
  }
  const row = await prisma.operatorSigningKey.findFirst({
    where: {
      operatorId,
      kid: header.kid,
      status: { in: ['ACTIVE', 'RETIRING'] },
      OR: [{ notAfter: null }, { notAfter: { gt: new Date() } }],
    },
  });
  if (!row) return null;
  const pubJwk = row.publicJwk as unknown as Jwk;
  const publicKey = jwkToPublicKey({ ...pubJwk, kid: row.kid });
  const joseSig = fromBase64Url(s!);
  const derSig = joseToDer(joseSig);
  const signingInput = `${h}.${p}`;
  const ok = crypto.verify('sha256', Buffer.from(signingInput), {
    key: publicKey,
    dsaEncoding: 'der',
  }, derSig);
  if (!ok) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(fromBase64Url(p!).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    return null;
  }
  return claims;
}
