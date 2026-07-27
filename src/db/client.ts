import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

export const prisma = new PrismaClient();

/** Enable WAL so API reads are not blocked by ingestion writes (spec §8.7). */
export async function initDb(): Promise<void> {
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
    logger.debug('SQLite WAL enabled');
  } catch {
    // Postgres — no-op.
  }
}

export function parseJsonField<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
