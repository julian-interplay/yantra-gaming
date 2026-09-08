// Canonical wallet contract between the RGS and the operator.
// Mirrors packages/wallet-spec — kept in sync.
//
// Money is BigInt micro-units. 1 LKR = 100_000 micro. Never floats.

export type Currency = string; // ISO 4217 (or crypto symbol)
export type PlayerRef = string;
export type Uuid = string;

/** Status codes returned by the operator's wallet or emitted by us on timeout. */
export const RsStatus = {
  OK: 'RS_OK',
  UNKNOWN: 'RS_ERROR_UNKNOWN',
  INVALID_TOKEN: 'RS_ERROR_INVALID_TOKEN',
  INVALID_SIGNATURE: 'RS_ERROR_INVALID_SIGNATURE',
  INVALID_PARTNER: 'RS_ERROR_INVALID_PARTNER',
  NOT_ENOUGH_MONEY: 'RS_ERROR_NOT_ENOUGH_MONEY',
  USER_DISABLED: 'RS_ERROR_USER_DISABLED',
  TOKEN_EXPIRED: 'RS_ERROR_TOKEN_EXPIRED',
  WRONG_CURRENCY: 'RS_ERROR_WRONG_CURRENCY',
  WRONG_SYNTAX: 'RS_ERROR_WRONG_SYNTAX',
  WRONG_TYPES: 'RS_ERROR_WRONG_TYPES',
  DUPLICATE_TRANSACTION: 'RS_ERROR_DUPLICATE_TRANSACTION',
  TRANSACTION_NOT_FOUND: 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST',
  LIMIT_REACHED: 'RS_ERROR_LIMIT_REACHED',
  /** Synthetic: caller (RGS) timed out waiting for a response — triggers rollback. */
  TIMEOUT: 'RS_ERROR_TIMEOUT',
} as const;

export type RsStatus = typeof RsStatus[keyof typeof RsStatus];

/** Errors on which we do NOT rollback — the bet is cleanly rejected. */
export const REJECT_STATUSES: ReadonlySet<RsStatus> = new Set([
  RsStatus.NOT_ENOUGH_MONEY,
  RsStatus.LIMIT_REACHED,
  RsStatus.USER_DISABLED,
]);

/** Errors on which the operator already accepted the tx — treat as success. */
export const DUPLICATE_STATUSES: ReadonlySet<RsStatus> = new Set([
  RsStatus.DUPLICATE_TRANSACTION,
]);

// ── Request / response payloads ─────────────────────────────

export interface WalletCommon {
  requestUuid: Uuid;
  operatorId: string;
  playerRef: PlayerRef;
  currency: Currency;
  gameCode: string;
}

export interface BalanceRequest extends WalletCommon {}

export interface BetRequest extends WalletCommon {
  transactionUuid: Uuid;
  amountMicro: bigint;
  roundId: Uuid;
  isFree?: boolean;
  meta?: Record<string, unknown>;
}

export interface WinRequest extends WalletCommon {
  transactionUuid: Uuid;
  referenceTransactionUuid: Uuid; // the bet this win settles
  amountMicro: bigint;
  roundId: Uuid;
  meta?: Record<string, unknown>;
}

export interface AwardRequest extends WalletCommon {
  transactionUuid: Uuid;
  amountMicro: bigint;
  prizeRef: string;
  tournamentId?: Uuid;
  rank?: number;
  meta?: Record<string, unknown>;
}

export interface RollbackRequest extends WalletCommon {
  transactionUuid: Uuid;                // new rollback tx id
  referenceTransactionUuid: Uuid;       // the bet or win being reversed
  roundId?: Uuid;
  meta?: Record<string, unknown>;
}

export interface WalletResponse {
  status: RsStatus;
  requestUuid: Uuid;
  balanceMicro?: bigint;  // not required on errors
  currency?: Currency;
  message?: string;
}

// ── Helpers ──────────────────────────────────────────────

export function isRejectStatus(s: RsStatus): boolean {
  return REJECT_STATUSES.has(s);
}

export function isSuccessOrDuplicate(s: RsStatus): boolean {
  return s === RsStatus.OK || DUPLICATE_STATUSES.has(s);
}
