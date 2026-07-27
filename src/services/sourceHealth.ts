/** Source health rollup for GET /sources/health (spec §9.2). */
import { prisma } from '../db/client';

export interface SourceHealth {
  source: string;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  successRate24h: number | null;
  avgLatencyMs: number | null;
  shapeDriftDetected: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
}

export async function sourceHealthReport(): Promise<SourceHealth[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const sources = ['BETANO', 'SOFASCORE', 'LEAGUE', 'ESPN'];
  const out: SourceHealth[] = [];
  for (const source of sources) {
    const rows = await prisma.scrapeLog.findMany({
      where: { source, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    const lastSuccess = rows.find((r) => r.success) ?? null;
    const lastFailure = rows.find((r) => !r.success) ?? null;
    const successRate = rows.length ? rows.filter((r) => r.success).length / rows.length : null;
    const latencies = rows.filter((r) => r.success && r.durationMs != null).map((r) => r.durationMs!);
    const drift = rows.some((r) => r.shapeChanged);
    let status: SourceHealth['status'] = 'UNKNOWN';
    if (rows.length) {
      if (successRate! >= 0.9) status = 'HEALTHY';
      else if (successRate! >= 0.5) status = 'DEGRADED';
      else status = 'DOWN';
    }
    out.push({
      source,
      lastSuccessAt: lastSuccess?.createdAt ?? null,
      lastFailureAt: lastFailure?.createdAt ?? null,
      successRate24h: successRate,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      shapeDriftDetected: drift,
      status,
    });
  }
  return out;
}
