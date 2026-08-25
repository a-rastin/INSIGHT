import { setTimeout as delay } from "node:timers/promises";

import type { Pool, PoolClient } from "pg";

import {
  appendJobProgress,
  claimNextJob,
  expireJobLease,
  releaseJobAfterFailure,
  renewJobLease,
  settleJobFromDomainResult,
  type DomainJobResult,
  type JobClaim,
  type JobProgress,
} from "./jobs.js";

export interface JobHandler {
  execute(claim: JobClaim, progress: (event: JobProgress) => Promise<void>): Promise<void>;
  resolveDomainResult(client: PoolClient, claim: JobClaim): Promise<DomainJobResult>;
}

export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;

export interface RunWorkerOptions {
  readonly pool: Pool;
  readonly workerId: string;
  readonly handlers: JobHandlerRegistry;
  readonly signal: AbortSignal;
  readonly pollMilliseconds?: number;
  readonly leaseMilliseconds?: number;
}

export async function runJobWorker(options: RunWorkerOptions): Promise<void> {
  const pollMilliseconds = options.pollMilliseconds ?? 500;
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  while (!options.signal.aborted) {
    const claim = await claimNextJob(options.pool, options.workerId, leaseMilliseconds);
    if (!claim) {
      await delay(pollMilliseconds, undefined, { signal: options.signal }).catch(() => undefined);
      continue;
    }
    if (options.signal.aborted) {
      await expireJobLease(options.pool, claim).catch(() => undefined);
      break;
    }

    const handler = options.handlers[claim.job.jobType];
    if (!handler) {
      await releaseJobAfterFailure(options.pool, claim, "EXECUTION_FAILED");
      continue;
    }

    let leaseLost = false;
    const heartbeat = setInterval(
      () => {
        void renewJobLease(options.pool, claim, leaseMilliseconds)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          });
      },
      Math.max(100, Math.floor(leaseMilliseconds / 3)),
    );
    heartbeat.unref();
    try {
      await handler.execute(claim, (event) => appendJobProgress(options.pool, claim, event));
      if (leaseLost) throw new Error("Job lease was lost.");
      await settleJobFromDomainResult(options.pool, claim, handler.resolveDomainResult);
    } catch {
      await releaseJobAfterFailure(options.pool, claim, "EXECUTION_FAILED").catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
