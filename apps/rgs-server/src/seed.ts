import crashMinimal from '@yantra-games/crash-minimal';
import ketapolaDice from '@yantra-games/ketapola-dice';
import lempiCrash from '@yantra-games/lempi-crash';
import bcrypt from 'bcryptjs';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { encryptSecret } from './utils/secrets.js';

// Pinned dev UUID so the mock-operator and the rgs-server seed agree on the
// same tenant id. Matches MOCK_OPERATOR_ID in the root .env.example.
const MOCK_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
const MOCK_OPERATOR_SLUG = 'mock-dev';
const MOCK_OPERATOR_API_KID = 'kid_mock_dev';
const MOCK_OPERATOR_API_SECRET = 'mock-dev-shared-secret';
const MOCK_OPERATOR_WALLET_KID = 'kid_mock_dev_wallet';
const MOCK_OPERATOR_WALLET_SECRET = 'mock-dev-wallet-secret';
const MOCK_WALLET_CALLBACK_URL = 'http://localhost:4300/wallet';

async function main(): Promise<void> {
  const operator = await prisma.operator.upsert({
    where: { id: MOCK_OPERATOR_ID },
    create: {
      id: MOCK_OPERATOR_ID,
      slug: MOCK_OPERATOR_SLUG,
      name: 'Mock Dev Operator',
      status: 'ACTIVE',
      testMode: true,
      jurisdiction: 'LK',
      defaultCurrency: 'HNL',
      allowedCurrencies: ['HNL', 'LKR'],
      walletCallbackUrl: MOCK_WALLET_CALLBACK_URL,
      ipAllowList: [],
      notes: 'Seeded for local development. Safe to destroy.',
    },
    update: {
      slug: MOCK_OPERATOR_SLUG,
      name: 'Mock Dev Operator',
      status: 'ACTIVE',
      testMode: true,
      jurisdiction: 'HN',
      defaultCurrency: 'HNL',
      allowedCurrencies: ['HNL', 'LKR'],
      walletCallbackUrl: MOCK_WALLET_CALLBACK_URL,
    },
  });
  logger.info('seed: operator', { id: operator.id, slug: operator.slug });

  const existingInbound = await prisma.operatorCredential.findUnique({
    where: { kid: MOCK_OPERATOR_API_KID },
  });
  if (!existingInbound) {
    await prisma.operatorCredential.create({
      data: {
        operatorId: operator.id,
        type: 'API_KEY_INBOUND',
        kid: MOCK_OPERATOR_API_KID,
        cipherBlob: encryptSecret(MOCK_OPERATOR_API_SECRET),
        label: 'dev inbound signing key',
      },
    });
    logger.info('seed: inbound credential created', { kid: MOCK_OPERATOR_API_KID });
  }

  const existingOutbound = await prisma.operatorCredential.findUnique({
    where: { kid: MOCK_OPERATOR_WALLET_KID },
  });
  if (!existingOutbound) {
    await prisma.operatorCredential.create({
      data: {
        operatorId: operator.id,
        type: 'WALLET_HMAC_OUTBOUND',
        kid: MOCK_OPERATOR_WALLET_KID,
        cipherBlob: encryptSecret(MOCK_OPERATOR_WALLET_SECRET),
        label: 'dev outbound wallet signing key',
      },
    });
    logger.info('seed: outbound credential created', { kid: MOCK_OPERATOR_WALLET_KID });
  }

  await prisma.operatorGameConfig.upsert({
    where: {
      operatorId_gameCode_currency: {
        operatorId: operator.id,
        gameCode: ketapolaDice.gameCode,
        currency: 'LKR',
      },
    },
    create: {
      operatorId: operator.id,
      gameCode: ketapolaDice.gameCode,
      currency: 'LKR',
      enabled: true,
      configJson: { lowWeight: 50, highWeight: 50 },
      configVersion: 'v1',
      // 1 LKR = 100_000 micro. 100 LKR = 10_000_000.
      minBetMicro: 10_000_000n,
      maxBetMicro: 10_000_000_000n,
      commissionMicro: 0n,
      bettingWindowMs: 15_000,
      rollingWindowMs: 4_000,
      cooldownMs: 3_000,
    },
    update: {
      enabled: true,
      configJson: { lowWeight: 50, highWeight: 50 },
    },
  });
  logger.info('seed: game config', { gameCode: ketapolaDice.gameCode, currency: 'LKR' });

  await prisma.operatorGameConfig.upsert({
    where: {
      operatorId_gameCode_currency: {
        operatorId: operator.id,
        gameCode: crashMinimal.gameCode,
        currency: 'LKR',
      },
    },
    create: {
      operatorId: operator.id,
      gameCode: crashMinimal.gameCode,
      currency: 'LKR',
      enabled: true,
      configJson: { houseEdge: 0.01, maxMultiplier: 1000 },
      configVersion: 'v1',
      minBetMicro: 10_000_000n,
      maxBetMicro: 10_000_000_000n,
      commissionMicro: 0n,
      bettingWindowMs: 15_000,
      rollingWindowMs: 4_000,
      cooldownMs: 3_000,
    },
    update: {
      enabled: true,
      configJson: { houseEdge: 0.01, maxMultiplier: 1000 },
    },
  });
  logger.info('seed: game config', { gameCode: crashMinimal.gameCode, currency: 'LKR' });

  await prisma.operatorGameConfig.upsert({
    where: {
      operatorId_gameCode_currency: {
        operatorId: operator.id,
        gameCode: lempiCrash.gameCode,
        currency: 'HNL',
      },
    },
    create: {
      operatorId: operator.id,
      gameCode: lempiCrash.gameCode,
      currency: 'HNL',
      enabled: true,
      configJson: {
        houseEdge: 0.01,
        maxMultiplier: 1000,
        multiplierGrowthRate: 0.00011,
        minFlightMs: 700,
        maxFlightMs: 120000,
        botCashoutsEnabled: true,
      },
      configVersion: 'v1',
      minBetMicro: 1_000_000n,
      maxBetMicro: 10_000_000_000n,
      commissionMicro: 0n,
      bettingWindowMs: 8_000,
      rollingWindowMs: 4_000,
      cooldownMs: 3_000,
    },
    update: {
      enabled: true,
      configJson: {
        houseEdge: 0.01,
        maxMultiplier: 1000,
        multiplierGrowthRate: 0.00011,
        minFlightMs: 700,
        maxFlightMs: 120000,
        botCashoutsEnabled: true,
      },
      minBetMicro: 1_000_000n,
      maxBetMicro: 10_000_000_000n,
      bettingWindowMs: 8_000,
    },
  });
  logger.info('seed: game config', { gameCode: lempiCrash.gameCode, currency: 'HNL' });

  const adminEmail = 'admin@mock-dev.local';
  const existingAdmin = await prisma.operatorUser.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.operatorUser.create({
      data: {
        operatorId: operator.id,
        email: adminEmail,
        passwordHash: await bcrypt.hash('admin123', 10),
        role: 'OPERATOR_ADMIN',
        displayName: 'Mock Admin',
      },
    });
    logger.info('seed: operator user created', { email: adminEmail, password: 'admin123' });
  } else {
    logger.info('seed: operator user already exists', { email: adminEmail });
  }

  const staffEmail = 'staff@yantra.local';
  const existingStaff = await prisma.operatorUser.findUnique({ where: { email: staffEmail } });
  if (!existingStaff) {
    await prisma.operatorUser.create({
      data: {
        operatorId: operator.id,
        email: staffEmail,
        passwordHash: await bcrypt.hash('staff123', 10),
        role: 'KETAPOLA_STAFF',
        displayName: 'Yantra Staff',
      },
    });
    logger.info('seed: staff user created', { email: staffEmail, password: 'staff123' });
  } else {
    logger.info('seed: staff user already exists', { email: staffEmail });
  }

  // Sample certificate so the cert-registry dashboard has something to display
  // in dev. Not a real lab issuance. Deliberately expires 3 years out so it
  // doesn't flap between "valid" and "expiring" during routine dev.
  const sampleCertId = 'DEV-Yantra-LK-0001';
  const existingCert = await prisma.certificate.findUnique({
    where: {
      gameCode_jurisdiction_lab_certId: {
        gameCode: ketapolaDice.gameCode,
        jurisdiction: 'LK',
        lab: 'ITECH',
        certId: sampleCertId,
      },
    },
  });
  if (!existingCert) {
    const now = new Date();
    await prisma.certificate.create({
      data: {
        gameCode: ketapolaDice.gameCode,
        jurisdiction: 'LK',
        lab: 'ITECH',
        certId: sampleCertId,
        buildHash: (process.env.BUILD_HASH ?? 'dev-unset').slice(0, 40),
        version: '1.0.0',
        rngVersion: ketapolaDice.cert.rngVersion,
        issuedAt: now,
        validFrom: now,
        expiresAt: new Date(Date.UTC(now.getUTCFullYear() + 3, now.getUTCMonth(), now.getUTCDate())),
        notes: 'Seed-generated placeholder. Replace with the real lab cert.',
      },
    });
    logger.info('seed: sample certificate created', { certId: sampleCertId });
  } else {
    logger.info('seed: sample certificate already exists', { certId: sampleCertId });
  }

  logger.info('seed complete');
}

main()
  .catch((err) => {
    logger.error('seed failed', { err: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
