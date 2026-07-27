import { Router } from 'express';
import { metaRouter } from './meta';
import { fixturesRouter } from './fixtures';
import { playersRouter } from './players';
import { injuriesRouter } from './injuries';
import { reconciliationRouter } from './reconciliation';
import { recommendationsRouter } from './recommendations';
import { analysisRouter } from './analysis';
import { adminRouter } from './admin';
import { settlementRouter } from './settlementBacktest';

export const apiRouter = Router();

apiRouter.use(metaRouter);
apiRouter.use(fixturesRouter);
apiRouter.use(playersRouter);
apiRouter.use(injuriesRouter);
apiRouter.use(reconciliationRouter);
apiRouter.use(recommendationsRouter);
apiRouter.use(analysisRouter);
apiRouter.use(adminRouter);
apiRouter.use(settlementRouter);
