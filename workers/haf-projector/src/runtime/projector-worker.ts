import { HafProjectorError } from '../errors.js';
import type { HafProjectorRunResult } from '../sync/haf-projector.js';

export interface ProjectorCyclePort {
  runOnce(): Promise<HafProjectorRunResult>;
}

export interface ProjectorWorkerOptions {
  readonly pollIntervalMs: number;
  readonly initialFailureBackoffMs: number;
  readonly maximumFailureBackoffMs: number;
}

export interface ProjectorWorkerLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  error(event: Readonly<Record<string, unknown>>): void;
}

export type ProjectorSleeper = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export class HafProjectorWorker {
  public constructor(
    private readonly projector: ProjectorCyclePort,
    private readonly options: ProjectorWorkerOptions,
    private readonly logger: ProjectorWorkerLogger,
    private readonly sleep: ProjectorSleeper = abortableDelay,
  ) {
    assertWorkerOptions(options);
  }

  public async run(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      let delayMs: number;
      try {
        const result = await this.projector.runOnce();
        consecutiveFailures = 0;
        delayMs = this.options.pollIntervalMs;
        this.logger.info({
          event: 'haf_projection_cycle_completed',
          appliedBlocks: result.appliedBlocks,
          finalizedThrough: result.finalizedThrough,
          revertedTo: result.revertedTo,
          sourceHead: result.sourceHead,
        });
      } catch (error: unknown) {
        consecutiveFailures += 1;
        delayMs = failureBackoff(
          consecutiveFailures,
          this.options.initialFailureBackoffMs,
          this.options.maximumFailureBackoffMs,
        );
        this.logger.error({
          event: 'haf_projection_cycle_failed',
          consecutiveFailures,
          retryAfterMs: delayMs,
          ...classifyFailure(error),
        });
      }

      if (!signal.aborted) {
        await this.sleep(delayMs, signal);
      }
    }
  }
}

export function createJsonConsoleLogger(): ProjectorWorkerLogger {
  return {
    info: (event) => console.log(JSON.stringify({ level: 'info', ...event })),
    error: (event) => console.error(JSON.stringify({ level: 'error', ...event })),
  };
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

function failureBackoff(failures: number, initial: number, maximum: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(maximum, initial * 2 ** exponent);
}

function classifyFailure(error: unknown): Readonly<Record<string, string>> {
  if (error instanceof HafProjectorError) {
    return { errorType: error.name, errorCode: error.code };
  }
  // Unexpected (non-domain) errors are logged by stable code only. Their raw
  // messages may embed secrets (e.g. a Postgres connection string with a
  // password), so they are never emitted — see the worker spec's leak guard.
  return { errorType: 'UnexpectedError', errorCode: 'unexpected_error' };
}

function assertWorkerOptions(options: ProjectorWorkerOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (options.maximumFailureBackoffMs < options.initialFailureBackoffMs) {
    throw new TypeError('maximumFailureBackoffMs must not be less than initialFailureBackoffMs');
  }
}
