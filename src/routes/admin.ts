import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJsonField } from '../db/client';
import { asyncRoute } from '../middleware/errorHandler';
import { validateQuery, validateBody, q } from '../middleware/validate';
import { ok } from './helpers';
import { normaliseName } from '../lib/normalise';

export const adminRouter = Router();

const queueSchema = z.object({ status: z.string().default('PENDING'), limit: z.coerce.number().default(100) });

adminRouter.get(
  '/admin/entity-review',
  validateQuery(queueSchema),
  asyncRoute(async (req, res) => {
    const query = q<z.infer<typeof queueSchema>>(req);
    const items = await prisma.entityReviewItem.findMany({
      where: { status: { in: query.status.split(',') } },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    // Hydrate candidate ids into names so the reviewer sees something useful.
    const hydrated = await Promise.all(
      items.map(async (item) => {
        const parsed = parseJsonField<{ candidateIds?: string[]; note?: string }>(item.candidates, {});
        const players = parsed.candidateIds?.length
          ? await prisma.player.findMany({
              where: { id: { in: parsed.candidateIds } },
              include: { team: { select: { abbreviation: true } } },
            })
          : [];
        return {
          ...item,
          note: parsed.note ?? null,
          candidates: players.map((p) => ({
            id: p.id,
            fullName: p.fullName,
            team: p.team?.abbreviation ?? null,
            normalised: p.normalised,
          })),
        };
      }),
    );
    ok(req, res, hydrated, { count: hydrated.length });
  }),
);

const resolveSchema = z.object({ playerId: z.string().min(1) });

/** Resolving does three things: SourceIdentity, PlayerAlias, close the item (§9.10). */
adminRouter.post(
  '/admin/entity-review/:id/resolve',
  validateBody(resolveSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof resolveSchema>;
    const item = await prisma.entityReviewItem.findUniqueOrThrow({ where: { id: req.params.id } });
    const normalised = normaliseName(item.rawName);

    await prisma.$transaction(async (tx) => {
      const existingAlias = await tx.playerAlias.findFirst({ where: { normalised, source: item.source } });
      if (!existingAlias) {
        await tx.playerAlias.create({
          data: { playerId: body.playerId, alias: item.rawName, normalised, source: item.source },
        });
      }
      await tx.entityReviewItem.update({
        where: { id: item.id },
        data: { status: 'RESOLVED', resolvedToId: body.playerId, resolvedAt: new Date() },
      });
    });

    ok(req, res, { id: item.id, status: 'RESOLVED', playerId: body.playerId, aliasWritten: normalised });
  }),
);

const rejectSchema = z.object({ reason: z.string().min(1) });

adminRouter.post(
  '/admin/entity-review/:id/reject',
  validateBody(rejectSchema),
  asyncRoute(async (req, res) => {
    const item = await prisma.entityReviewItem.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', resolvedAt: new Date() },
    });
    ok(req, res, item);
  }),
);

const aliasSchema = z.object({
  entityType: z.enum(['PLAYER', 'TEAM']),
  entityId: z.string().min(1),
  alias: z.string().min(1),
  source: z.string().optional(),
});

adminRouter.post(
  '/admin/aliases',
  validateBody(aliasSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof aliasSchema>;
    const normalised = normaliseName(body.alias);
    const row =
      body.entityType === 'PLAYER'
        ? await prisma.playerAlias.create({
            data: { playerId: body.entityId, alias: body.alias, normalised, source: body.source ?? null },
          })
        : await prisma.teamAlias.create({
            data: { teamId: body.entityId, alias: body.alias, normalised, source: body.source ?? null },
          });
    ok(req, res, row);
  }),
);
