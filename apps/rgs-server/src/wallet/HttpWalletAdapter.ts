import {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@yantra/wallet-spec';
import { logger } from '../logger.js';
import { signPayload } from '../utils/signing.js';
import type { WalletAdapter } from './WalletAdapter.js';
import {
  type BalanceRequest,
  type AwardRequest,
  type BetRequest,
  type RollbackRequest,
  RsStatus,
  type WalletResponse,
  type WinRequest,
} from './types.js';

export interface HttpWalletAdapterOptions {
  operatorId: string;
  kid: string;                  // our outbound key-id this operator expects us to present
  secret: string;               // HMAC secret shared with operator
  walletCallbackUrl: string;    // e.g. https://casino.example.com/wallet
  timeoutMs?: number;
}

type Endpoint = 'balance' | 'bet' | 'win' | 'award' | 'rollback';

export class HttpWalletAdapter implements WalletAdapter {
  private readonly kid: string;
  private readonly secret: string;
  private readonly base: string;
  /**
   * Path component of the operator wallet callback URL, used as the prefix
   * in the HMAC canonical string. The operator verifies the signature against
   * the full request path they receive (e.g. `/wallet/balance`), so we must
   * sign the same full path — not just `/balance`.
   */
  private readonly basePath: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpWalletAdapterOptions) {
    this.kid = opts.kid;
    this.secret = opts.secret;
    this.base = opts.walletCallbackUrl.replace(/\/$/, '');
    try {
      const parsed = new URL(this.base);
      this.basePath = parsed.pathname.replace(/\/$/, '');
    } catch {
      this.basePath = this.base.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
    }
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async balance(req: BalanceRequest): Promise<WalletResponse> {
    return this.call('balance', req.requestUuid, {
      requestUuid: req.requestUuid,
      operatorId: req.operatorId,
      playerRef: req.playerRef,
      currency: req.currency,
      gameCode: req.gameCode,
    });
  }

  async bet(req: BetRequest): Promise<WalletResponse> {
    return this.call('bet', req.requestUuid, {
      requestUuid: req.requestUuid,
      transactionUuid: req.transactionUuid,
      operatorId: req.operatorId,
      playerRef: req.playerRef,
      currency: req.currency,
      gameCode: req.gameCode,
      // Wire format per the roadmap §5.2 is integer micro-units as a string,
      // NOT a decimal major-units string. The operator calls BigInt() on it.
      amountMicro: req.amountMicro.toString(),
      roundId: req.roundId,
      isFree: req.isFree ?? false,
      meta: req.meta ?? {},
    });
  }

  async win(req: WinRequest): Promise<WalletResponse> {
    return this.call('win', req.requestUuid, {
      requestUuid: req.requestUuid,
      transactionUuid: req.transactionUuid,
      referenceTransactionUuid: req.referenceTransactionUuid,
      operatorId: req.operatorId,
      playerRef: req.playerRef,
      currency: req.currency,
      gameCode: req.gameCode,
      amountMicro: req.amountMicro.toString(),
      roundId: req.roundId,
      meta: req.meta ?? {},
    });
  }

  async award(req: AwardRequest): Promise<WalletResponse> {
    return this.call('award', req.requestUuid, {
      requestUuid: req.requestUuid,
      transactionUuid: req.transactionUuid,
      operatorId: req.operatorId,
      playerRef: req.playerRef,
      currency: req.currency,
      gameCode: req.gameCode,
      amountMicro: req.amountMicro.toString(),
      prizeRef: req.prizeRef,
      tournamentId: req.tournamentId,
      rank: req.rank,
      meta: req.meta ?? {},
    });
  }

  async rollback(req: RollbackRequest): Promise<WalletResponse> {
    return this.call('rollback', req.requestUuid, {
      requestUuid: req.requestUuid,
      transactionUuid: req.transactionUuid,
      referenceTransactionUuid: req.referenceTransactionUuid,
      operatorId: req.operatorId,
      playerRef: req.playerRef,
      currency: req.currency,
      gameCode: req.gameCode,
      roundId: req.roundId,
      meta: req.meta ?? {},
    });
  }

  private async call(
    endpoint: Endpoint,
    requestUuid: string,
    body: Record<string, unknown>,
  ): Promise<WalletResponse> {
    // The operator verifies the HMAC against the full request path they
    // receive (e.g. `/wallet/balance`), so the signed path must be the
    // absolute path on the operator's host, not just the endpoint name.
    const path = `${this.basePath}/${endpoint}`;
    const url = `${this.base}/${endpoint}`;
    const bodyJson = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signPayload(this.secret, 'POST', path, timestamp, bodyJson);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [KEY_ID_HEADER]: this.kid,
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signature,
        },
        body: bodyJson,
        signal: controller.signal,
      });

      if (res.status >= 500) {
        return { status: RsStatus.UNKNOWN, requestUuid, message: `operator_5xx_${res.status}` };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = (await res.json()) as Record<string, unknown>;
      } catch {
        return { status: RsStatus.UNKNOWN, requestUuid, message: 'invalid_json_response' };
      }

      const status = (parsed.status as string | undefined) ?? RsStatus.UNKNOWN;
      const out: WalletResponse = {
        status: status as WalletResponse['status'],
        requestUuid: (parsed.requestUuid as string) ?? requestUuid,
        message: parsed.message as string | undefined,
      };
      if (typeof parsed.balanceMicro === 'string') {
        try {
          // Wire format is integer micro-units as a string.
          out.balanceMicro = BigInt(parsed.balanceMicro);
        } catch {
          // ignore — leave undefined
        }
      }
      if (typeof parsed.currency === 'string') out.currency = parsed.currency;
      return out;
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      logger.warn('wallet http call failed', {
        endpoint,
        aborted,
        err: (err as Error).message,
      });
      return {
        status: aborted ? RsStatus.TIMEOUT : RsStatus.UNKNOWN,
        requestUuid,
        message: aborted ? 'timeout' : 'network_error',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
