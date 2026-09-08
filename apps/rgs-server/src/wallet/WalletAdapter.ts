import type {
  BalanceRequest,
  AwardRequest,
  BetRequest,
  RollbackRequest,
  WalletResponse,
  WinRequest,
} from './types.js';

/**
 * Contract between the game engine and "wherever the money lives".
 *
 * Two implementations ship in this repo:
 *   - HttpWalletAdapter      — HMAC-signed HTTP calls to the operator's wallet (default).
 *   - InternalWalletAdapter  — in-process fake wallet, for demos and local dev.
 *
 * Rules every implementation must honour:
 *   1. IDEMPOTENCY. Every money-moving method takes a caller-generated
 *      `transactionUuid`. Same transactionUuid + same operator MUST return
 *      a consistent result, even across retries. No double debits.
 *   2. ERROR SEMANTICS.
 *        - RS_OK                       → committed.
 *        - RS_ERROR_NOT_ENOUGH_MONEY   → cleanly rejected, caller should NOT rollback.
 *        - RS_ERROR_LIMIT_REACHED      → cleanly rejected, caller should NOT rollback.
 *        - everything else / timeout   → uncertain, caller WILL issue a rollback.
 *   3. NO SIDE EFFECTS ON READ. `balance()` is never idempotency-cached.
 *   4. LOGGING IS THE ENGINE'S JOB. The adapter returns a result; the engine
 *      writes `WalletCall` audit rows. Adapter must not silently swallow errors.
 */
export interface WalletAdapter {
  balance(req: BalanceRequest): Promise<WalletResponse>;
  bet(req: BetRequest): Promise<WalletResponse>;
  win(req: WinRequest): Promise<WalletResponse>;
  award(req: AwardRequest): Promise<WalletResponse>;
  rollback(req: RollbackRequest): Promise<WalletResponse>;
}
