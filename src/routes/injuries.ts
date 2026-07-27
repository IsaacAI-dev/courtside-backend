import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, validateBody, q } from '../middleware/validate';
import { ok } from './helpers';
import { recordInjury } from '../services/ingestion';
import { INJURY_STATUSES } from '../lib/types';

export const injuriesRouter = Router();

const listSchema = z.object({ league: z.string().optional(), status: z.string().optional(), teamId: z.string().optional() });

injuriesRouter.get(
  '/injuries',
  validateQuery(listSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof listSchema>>(req);
    const rows = await prisma.injuryStatus.findMany({
      where: {
        isCurrent: true,
        ...(query.status ? { status: { in: query.status.split(',') } } : {}),
        player: {
          ...(query.league ? { leagueId: query.league } : {}),
          ...(query.teamId ? { teamId: query.teamId } : {}),
        },
      },
      include: { player: { select: { id: true, fullName: true, teamId: true, team: { select: { abbreviation: true } } } } },
      orderBy: { reportedAt: 'desc' },
    });
    ok(req, res, rows, { count: rows.length });
  }),
);

injuriesRouter.get(
  '/injuries/:playerId/history',
  asyncRoute(async (req, res) => {
    const rows = await prisma.injuryStatus.findMany({
      where: { playerId: req.params.playerId },
      orderBy: { capturedAt: 'desc' },
    });
    ok(req, res, rows);
  }),
);

const manualSchema = z.object({
  playerId: z.string().min(1),
  status: z.enum(INJURY_STATUSES),
  reason: z.string().optional(),
  detail: z.string().optional(),
});

/** MANUAL writes at highest precedence — essential for the WNBA (§9.5). */
injuriesRouter.post(
  '/injuries/manual',
  validateBody(manualSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof manualSchema>;
    await recordInjury(body.playerId, body.status, body.detail ?? body.reason ?? null, 'MANUAL', new Date());
    const row = await prisma.injuryStatus.findFirst({
      where: { playerId: body.playerId, source: 'MANUAL', isCurrent: true },
      orderBy: { capturedAt: 'desc' },
    });
    ok(req, res, row);
  }),
);
