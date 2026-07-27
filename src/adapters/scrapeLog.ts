import { prisma } from '../db/client';
import { shapeHash } from '../lib/shapeHash';
import { parseJsonField } from '../db/client';

/**
 * Wraps every adapter call: records success/failure, latency, and detects
 * shape drift by comparing against the last stored hash for this operation.
 */
export async function withScrapeLog<T>(
  source: string,
  operation: string,
  tier: 'DIRECT' | 'BROWSER',
  fn: () => Promise<T>,
  itemCounter?: (result: T) => number,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();

    const hash = shapeHash(result);
    const prev = await prisma.scrapeLog.findFirst({
      where: { source, operation, success: true },
      orderBy: { createdAt: 'desc' },
      select: { errorMessage: true },
    });
    // shape hash is smuggled into errorMessage on success rows: "shape:<hash>"
    const prevHash = prev?.errorMessage?.startsWith('shape:') ? prev.errorMessage.slice(6) : null;
    const shapeChanged = prevHash !== null && prevHash !== hash;

    await prisma.scrapeLog.create({
      data: {
        source,
        operation,
        tier,
        success: true,
        durationMs: Date.now() - started,
        itemCount: itemCounter ? itemCounter(result) : null,
        errorMessage: `shape:${hash}`,
        shapeChanged,
      },
    });
    return result;
  } catch (err) {
    const status = (err as { status?: number }).status ?? null;
    await prisma.scrapeLog.create({
      data: {
        source,
        operation,
        tier,
        success: false,
        httpStatus: status,
        durationMs: Date.now() - started,
        errorMessage: String(err).slice(0, 500),
      },
    });
    throw err;
  }
}
