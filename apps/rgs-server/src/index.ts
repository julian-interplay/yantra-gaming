import { createServer } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config.js';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { v1Router } from './routes/index.js';
import { metricsRouter } from './routes/metrics.js';
import { initEngineRegistry } from './services/EngineRegistry.js';
import { pendingJobRunner } from './services/PendingJobRunner.js';
import { reconciliationJob } from './services/ReconciliationJob.js';
import { initRpsTournamentService } from './services/RpsTournamentService.js';
import { webhookDispatcher } from './services/WebhookDispatcher.js';
import { attachGameSocket } from './socket/gameSocket.js';

async function main(): Promise<void> {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      // Strict-Transport-Security: 2 years, include subdomains, preload-ready.
      // Effectively a no-op on http://localhost but required in production.
      hsts: {
        maxAge: 63_072_000, // 2 years
        includeSubDomains: true,
        preload: true,
      },
      // The game-client is a separate app loaded as an iframe. Its CSP is set
      // on its Vite build, not here. The RGS itself serves only JSON + a
      // Prometheus metrics endpoint, so a minimal default-src 'none' CSP is
      // safe and hides any errant HTML response.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      // We don't issue cookies from this server; block all cross-origin
      // resource sharing at the header level.
      crossOriginResourcePolicy: { policy: 'same-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
    }),
  );
  app.use(cookieParser());

  // Capture raw body for HMAC verification, then proceed with normal JSON parsing.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  // Global soft rate-limit; per-route limits could be tighter.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.use(healthRouter);
  app.use(metricsRouter); // GET /metrics — Prometheus exposition
  app.use('/v1', v1Router);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled_error', { err: err.message, stack: err.stack });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    path: '/socket.io',
  });

  initEngineRegistry(io);
  const rpsTournamentService = initRpsTournamentService(io);
  attachGameSocket(io);

  httpServer.listen(config.port, () => {
    logger.info('rgs-server listening', {
      port: config.port,
      env: config.nodeEnv,
      corsOrigin: config.corsOrigin,
    });
  });

  // Background workers
  pendingJobRunner.start();
  reconciliationJob.start();
  webhookDispatcher.start();
  rpsTournamentService.start();

  // Start engines for operators marked active.
  const registry = (await import('./services/EngineRegistry.js')).getEngineRegistry();
  await registry.startAllEnabled();

  // Certificate coverage audit — fire-and-forget; boot does not block on it.
  // Warnings are logged; the platform /certificates page surfaces the same
  // state to the cockpit.
  void import('./services/CertRegistry.js').then((m) => m.checkCertificateCoverage().catch((err) => {
    logger.error('cert-coverage check failed', { err: err instanceof Error ? err.message : String(err) });
  }));

  // Runtime build-hash attestation boot sweep. In strict mode
  // (RGS_CERT_STRICT=1), any operator whose live build doesn't match a
  // non-expired certificate will be blocked from starting an engine;
  // this sweep logs every gap so the gap is auditable before traffic.
  void import('./services/BuildAttestation.js').then((m) =>
    m.buildAttestation.checkBoot().catch((err) => {
      logger.error('build-attestation boot sweep failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );

  // Clock-skew monitor: checks local wall-clock against NTP reference
  // at boot and every 15 min. Alerts if drift > 250 ms (round phase
  // timestamps are derived from Date.now(); drift forges audit trail).
  void import('./services/ClockSkewMonitor.js').then((m) => m.clockSkewMonitor.start());

  // Sweep expired WebAuthn challenges on boot. The rows are short-lived
  // (5 min TTL) — a dangling backlog would only grow if a spike of
  // abandoned login attempts accumulated.
  void import('./services/Webauthn.js').then((m) =>
    m.sweepExpiredChallenges().catch((err) => {
      logger.warn('webauthn_challenge_sweep_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );

  const shutdown = async (signal: string) => {
    logger.info('shutdown', { signal });
    pendingJobRunner.stop();
    reconciliationJob.stop();
    webhookDispatcher.stop();
    rpsTournamentService.stop();
    const { clockSkewMonitor } = await import('./services/ClockSkewMonitor.js');
    clockSkewMonitor.stop();
    await registry.stopAll();
    httpServer.close();
    io.close();
    await prisma.$disconnect();
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal boot error', { err: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
