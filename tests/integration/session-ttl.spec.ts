import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
  normaliseSessionTtlSeconds,
} from '../../apps/rgs-server/src/services/SessionService.js';

describe('session TTL policy', () => {
  it('defaults to 4 hours', () => {
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(14_400);
    expect(normaliseSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });

  it('caps requested TTLs to the server policy bounds', () => {
    expect(MIN_SESSION_TTL_SECONDS).toBe(300);
    expect(MAX_SESSION_TTL_SECONDS).toBe(28_800);
    expect(normaliseSessionTtlSeconds(60)).toBe(MIN_SESSION_TTL_SECONDS);
    expect(normaliseSessionTtlSeconds(14_400)).toBe(14_400);
    expect(normaliseSessionTtlSeconds(86_400)).toBe(MAX_SESSION_TTL_SECONDS);
  });
});
