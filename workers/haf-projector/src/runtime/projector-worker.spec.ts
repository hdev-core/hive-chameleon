import { describe, expect, it } from 'vitest';

import { HafProjectorError } from '../errors.js';
import type { HafProjectorRunResult } from '../sync/haf-projector.js';
import {
  HafProjectorWorker,
  type ProjectorCyclePort,
  type ProjectorWorkerLogger,
} from './projector-worker.js';

const successfulResult: HafProjectorRunResult = {
  appliedBlocks: 2,
  finalizedThrough: 100,
  revertedTo: null,
  sourceHead: 102,
};

describe('HAF projector polling worker', () => {
  it('backs off failures exponentially, recovers, and stops without another cycle', async () => {
    const abortController = new AbortController();
    const projector = new SequencedProjector([
      new HafProjectorError('source_unavailable', 'fixture unavailable'),
      new HafProjectorError('source_unavailable', 'fixture unavailable'),
      successfulResult,
    ]);
    const logger = new RecordingLogger();
    const delays: number[] = [];
    const worker = new HafProjectorWorker(
      projector,
      {
        pollIntervalMs: 50,
        initialFailureBackoffMs: 100,
        maximumFailureBackoffMs: 500,
      },
      logger,
      async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) {
          abortController.abort();
        }
      },
    );

    await worker.run(abortController.signal);

    expect(delays).toEqual([100, 200, 50]);
    expect(projector.calls).toBe(3);
    expect(logger.errors.map((event) => event.errorCode)).toEqual([
      'source_unavailable',
      'source_unavailable',
    ]);
    expect(logger.infos).toContainEqual({
      event: 'haf_projection_cycle_completed',
      appliedBlocks: 2,
      finalizedThrough: 100,
      revertedTo: null,
      sourceHead: 102,
    });
  });

  it('does not log error messages or endpoint-bearing unknown errors', async () => {
    const abortController = new AbortController();
    const logger = new RecordingLogger();
    const worker = new HafProjectorWorker(
      new SequencedProjector([new Error('postgres://user:secret@database.internal/database')]),
      {
        pollIntervalMs: 50,
        initialFailureBackoffMs: 100,
        maximumFailureBackoffMs: 500,
      },
      logger,
      async () => abortController.abort(),
    );

    await worker.run(abortController.signal);

    expect(JSON.stringify(logger.errors)).not.toContain('secret');
    expect(logger.errors[0]).toMatchObject({
      errorType: 'UnexpectedError',
      errorCode: 'unexpected_error',
    });
  });

  it('finishes a running cycle and skips sleeping after shutdown is requested', async () => {
    const abortController = new AbortController();
    let releaseCycle: (() => void) | undefined;
    const cycleStarted = new Promise<void>((resolve) => {
      releaseCycle = resolve;
    });
    let runStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let sleepCalls = 0;
    const projector: ProjectorCyclePort = {
      runOnce: async () => {
        runStarted?.();
        await cycleStarted;
        return successfulResult;
      },
    };
    const worker = new HafProjectorWorker(
      projector,
      {
        pollIntervalMs: 50,
        initialFailureBackoffMs: 100,
        maximumFailureBackoffMs: 500,
      },
      new RecordingLogger(),
      async () => {
        sleepCalls += 1;
      },
    );

    const running = worker.run(abortController.signal);
    await started;
    abortController.abort();
    releaseCycle?.();
    await running;

    expect(sleepCalls).toBe(0);
  });
});

class SequencedProjector implements ProjectorCyclePort {
  public calls = 0;

  public constructor(private readonly outcomes: readonly (Error | HafProjectorRunResult)[]) {}

  public async runOnce(): Promise<HafProjectorRunResult> {
    const outcome = this.outcomes[this.calls];
    this.calls += 1;
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome === undefined) {
      throw new Error('Fixture outcome missing');
    }
    return outcome;
  }
}

class RecordingLogger implements ProjectorWorkerLogger {
  public readonly infos: Array<Readonly<Record<string, unknown>>> = [];
  public readonly errors: Array<Readonly<Record<string, unknown>>> = [];

  public info(event: Readonly<Record<string, unknown>>): void {
    this.infos.push(event);
  }

  public error(event: Readonly<Record<string, unknown>>): void {
    this.errors.push(event);
  }
}
