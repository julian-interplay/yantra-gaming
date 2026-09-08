// POST /wallet/balance | /wallet/bet | /wallet/win | /wallet/award | /wallet/rollback
//
// Spec-conformant surface for the RGS's HttpWalletAdapter to talk to during
// local development. Verifies inbound HMAC using MOCK_OPERATOR_WALLET_SECRET.
//
// Bodies follow @yantra/wallet-spec wire types. We preserve the raw body
// bytes when verifying signature so that JSON re-serialisation can't change
// the hashed input.

import { Router, type Request, type Response } from 'express';
import {
  RsStatus,
  fromMicro,
  type BalanceRequestWire,
  type AwardRequestWire,
  type BetRequestWire,
  type WinRequestWire,
  type RollbackRequestWire,
  type WalletResponseWire,
} from '@yantra/wallet-spec';
import { config } from '../config.js';
import { getStore } from './store.js';
import {
  verifyInboundSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  KEY_ID_HEADER,
} from './signing.js';

// ── Raw-body parser just for /wallet/* ──────────────────────────────────
// express.json() throws away the raw bytes. We need them intact for HMAC.
function rawJson(req: Request, _res: Response, next: (err?: unknown) => void) {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    (req as Request & { rawBody: Buffer }).rawBody = raw;
    if (raw.length === 0) {
      req.body = {};
    } else {
      try {
        req.body = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        return next(err);
      }
    }
    next();
  });
  req.on('error', next);
}

function getRaw(req: Request): Buffer {
  return (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
}

function singleHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

// ── Signature gate ─────────────────────────────────────────────────────
function requireValidSignature(req: Request, res: Response): boolean {
  const kid = singleHeader(req, KEY_ID_HEADER);
  const timestamp = singleHeader(req, TIMESTAMP_HEADER);
  const signature = singleHeader(req, SIGNATURE_HEADER);

  // We only know one secret; reject unknown kids quickly.
  if (!kid) {
    sendError(req, res, RsStatus.INVALID_SIGNATURE, 'missing key id');
    return false;
  }

  // Path used in the canonical string is the HTTP request path, not the
  // router-relative path. The RGS signs against `/wallet/bet` etc.
  const verify = verifyInboundSignature({
    secret: config.walletSecret,
    method: req.method,
    path: req.originalUrl.split('?')[0]!,
    timestamp,
    signature,
    body: getRaw(req),
    windowSeconds: config.signatureWindowSeconds,
  });

  if (!verify.ok) {
    sendError(req, res, RsStatus.INVALID_SIGNATURE, verify.reason);
    return false;
  }
  return true;
}

function sendError(req: Request, res: Response, status: string, message?: string): void {
  const requestUuid = (req.body as { requestUuid?: string } | undefined)?.requestUuid ?? '';
  const payload: WalletResponseWire = {
    status: status as WalletResponseWire['status'],
    requestUuid,
    ...(message ? { message } : {}),
  };
  res.status(status === RsStatus.INVALID_SIGNATURE ? 401 : 200).json(payload);
}

// ── Router ─────────────────────────────────────────────────────────────
export const walletRouter = Router();

walletRouter.use(rawJson);

// Balance — operator-owned, read-only.
walletRouter.post('/balance', (req, res) => {
  if (!requireValidSignature(req, res)) return;
  const body = req.body as BalanceRequestWire;
  if (!body?.requestUuid || !body.playerRef || !body.currency) {
    return sendError(req, res, RsStatus.WRONG_SYNTAX, 'missing required fields');
  }
  const store = getStore(config.operatorId);
  const balanceMicro = store.balance(body.operatorId ?? config.operatorId, body.playerRef);
  const payload: WalletResponseWire = {
    status: RsStatus.OK,
    requestUuid: body.requestUuid,
    balanceMicro: balanceMicro.toString(),
    currency: body.currency,
  };
  res.json(payload);
});

// Bet — debit.
walletRouter.post('/bet', (req, res) => {
  if (!requireValidSignature(req, res)) return;
  const body = req.body as BetRequestWire;
  if (
    !body?.requestUuid ||
    !body.transactionUuid ||
    !body.playerRef ||
    !body.currency ||
    !body.amountMicro
  ) {
    return sendError(req, res, RsStatus.WRONG_SYNTAX, 'missing required fields');
  }

  const store = getStore(config.operatorId);
  const operatorId = body.operatorId ?? config.operatorId;

  // Request-level idempotency.
  const prev = store.recallRequest(body.requestUuid);
  if (prev !== undefined) {
    const payload: WalletResponseWire = {
      status: RsStatus.OK,
      requestUuid: body.requestUuid,
      balanceMicro: prev.toString(),
      currency: body.currency,
    };
    return res.json(payload);
  }

  // amountMicro is an integer string in micro-units per wire format.
  let amount: bigint;
  try {
    amount = BigInt(body.amountMicro);
  } catch {
    return sendError(req, res, RsStatus.WRONG_TYPES, 'amountMicro must be integer string');
  }

  const result = store.bet(operatorId, body.playerRef, body.transactionUuid, amount);
  if (result.status === RsStatus.OK) {
    store.rememberRequest(body.requestUuid, result.balanceMicro);
  }
  const payload: WalletResponseWire = {
    status: result.status,
    requestUuid: body.requestUuid,
    balanceMicro: result.balanceMicro.toString(),
    currency: body.currency,
  };
  res.json(payload);
});

// Win — credit, referencing a bet.
walletRouter.post('/win', (req, res) => {
  if (!requireValidSignature(req, res)) return;
  const body = req.body as WinRequestWire;
  if (
    !body?.requestUuid ||
    !body.transactionUuid ||
    !body.referenceTransactionUuid ||
    !body.playerRef ||
    !body.currency ||
    !body.amountMicro
  ) {
    return sendError(req, res, RsStatus.WRONG_SYNTAX, 'missing required fields');
  }
  const store = getStore(config.operatorId);
  const operatorId = body.operatorId ?? config.operatorId;

  const prev = store.recallRequest(body.requestUuid);
  if (prev !== undefined) {
    const payload: WalletResponseWire = {
      status: RsStatus.OK,
      requestUuid: body.requestUuid,
      balanceMicro: prev.toString(),
      currency: body.currency,
    };
    return res.json(payload);
  }

  let amount: bigint;
  try {
    amount = BigInt(body.amountMicro);
  } catch {
    return sendError(req, res, RsStatus.WRONG_TYPES, 'amountMicro must be integer string');
  }

  const result = store.win(operatorId, body.playerRef, body.transactionUuid, amount);
  if (result.status === RsStatus.OK) {
    store.rememberRequest(body.requestUuid, result.balanceMicro);
  }
  const payload: WalletResponseWire = {
    status: result.status,
    requestUuid: body.requestUuid,
    balanceMicro: result.balanceMicro.toString(),
    currency: body.currency,
  };
  res.json(payload);
});

// Award — F2P prize credit with no referenced bet transaction.
walletRouter.post('/award', (req, res) => {
  if (!requireValidSignature(req, res)) return;
  const body = req.body as AwardRequestWire;
  if (
    !body?.requestUuid ||
    !body.transactionUuid ||
    !body.playerRef ||
    !body.currency ||
    !body.amountMicro ||
    !body.prizeRef
  ) {
    return sendError(req, res, RsStatus.WRONG_SYNTAX, 'missing required fields');
  }
  const store = getStore(config.operatorId);
  const operatorId = body.operatorId ?? config.operatorId;

  const prev = store.recallRequest(body.requestUuid);
  if (prev !== undefined) {
    const payload: WalletResponseWire = {
      status: RsStatus.OK,
      requestUuid: body.requestUuid,
      balanceMicro: prev.toString(),
      currency: body.currency,
    };
    return res.json(payload);
  }

  let amount: bigint;
  try {
    amount = BigInt(body.amountMicro);
  } catch {
    return sendError(req, res, RsStatus.WRONG_TYPES, 'amountMicro must be integer string');
  }

  const result = store.award(operatorId, body.playerRef, body.transactionUuid, amount);
  if (result.status === RsStatus.OK) {
    store.rememberRequest(body.requestUuid, result.balanceMicro);
  }
  const payload: WalletResponseWire = {
    status: result.status,
    requestUuid: body.requestUuid,
    balanceMicro: result.balanceMicro.toString(),
    currency: body.currency,
  };
  res.json(payload);
});

// Rollback — reverses a bet or win by referenceTransactionUuid.
walletRouter.post('/rollback', (req, res) => {
  if (!requireValidSignature(req, res)) return;
  const body = req.body as RollbackRequestWire;
  if (
    !body?.requestUuid ||
    !body.transactionUuid ||
    !body.referenceTransactionUuid ||
    !body.playerRef ||
    !body.currency
  ) {
    return sendError(req, res, RsStatus.WRONG_SYNTAX, 'missing required fields');
  }
  const store = getStore(config.operatorId);
  const operatorId = body.operatorId ?? config.operatorId;

  const prev = store.recallRequest(body.requestUuid);
  if (prev !== undefined) {
    const payload: WalletResponseWire = {
      status: RsStatus.OK,
      requestUuid: body.requestUuid,
      balanceMicro: prev.toString(),
      currency: body.currency,
    };
    return res.json(payload);
  }

  const result = store.rollback(
    operatorId,
    body.playerRef,
    body.transactionUuid,
    body.referenceTransactionUuid,
  );
  if (result.status === RsStatus.OK) {
    store.rememberRequest(body.requestUuid, result.balanceMicro);
  }
  const payload: WalletResponseWire = {
    status: result.status,
    requestUuid: body.requestUuid,
    balanceMicro: result.balanceMicro.toString(),
    currency: body.currency,
  };
  res.json(payload);
});

// Debug — dump the map so the lobby can render balances. No signature.
walletRouter.get('/debug/balances', (_req, res) => {
  const store = getStore(config.operatorId);
  res.json({
    operatorId: config.operatorId,
    wallets: store.dump().map((w) => ({
      ...w,
      balanceDisplay: fromMicro(BigInt(w.balanceMicro)),
    })),
  });
});
