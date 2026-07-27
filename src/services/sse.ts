/** In-process event bus feeding the SSE endpoint (spec §9.11). */
import { EventEmitter } from 'node:events';

export interface RunEvent {
  runId: string;
  type: 'stage' | 'recommendation' | 'exclusion' | 'complete' | 'error';
  payload: unknown;
}

class RunBus extends EventEmitter {
  emitRun(event: RunEvent): void {
    this.emit(`run:${event.runId}`, event);
    this.emit('run:*', event);
  }
  onRun(runId: string, handler: (e: RunEvent) => void): () => void {
    const key = `run:${runId}`;
    this.on(key, handler);
    return () => this.off(key, handler);
  }
}

export const runBus = new RunBus();
runBus.setMaxListeners(100);
