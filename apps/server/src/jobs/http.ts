import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  JobResponseSchema,
  UuidSchema,
  type JobEvent,
  type JobResponse,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import { getOwnedJob, listOwnedJobEvents } from "./jobs.js";

const paramsSchema = Type.Object({ jobId: UuidSchema }, { additionalProperties: false });

const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function httpError(statusCode: 400 | 403 | 404): never {
  throw Object.assign(new Error("Job request rejected."), { statusCode });
}

function encodeEvent(event: JobEvent): string {
  return `id: ${event.id}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`;
}

export const jobRoutes =
  (
    pool: Pool,
    sessionForRequest: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { jobId: string } }>(
      "/jobs/:jobId",
      {
        schema: {
          operationId: "getJob",
          tags: ["jobs"],
          params: paramsSchema,
          response: { 200: JobResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request): Promise<JobResponse> => {
        const session = sessionForRequest(request);
        if (!session || session.user.role !== "PSYCHIATRIST") httpError(403);
        const job = await getOwnedJob(pool, request.params.jobId, session.user.id);
        if (!job) httpError(404);
        return { schemaVersion: CURRENT_SCHEMA_VERSION, job };
      },
    );

    app.get<{ Params: { jobId: string } }>(
      "/jobs/:jobId/events",
      {
        schema: {
          operationId: "streamJobEvents",
          tags: ["jobs"],
          params: paramsSchema,
          response: {
            200: {
              description: "Ordered durable job events",
              content: {
                "text/event-stream": { schema: Type.String() },
              },
            },
            default: ApiErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const session = sessionForRequest(request);
        if (!session || session.user.role !== "PSYCHIATRIST") httpError(403);
        const lastEventId = request.headers["last-event-id"];
        const rawId = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
        if (
          rawId !== undefined &&
          (!/^(?:0|[1-9][0-9]*)$/.test(rawId) ||
            rawId.length > 19 ||
            BigInt(rawId) > 9_223_372_036_854_775_807n)
        ) {
          httpError(400);
        }
        let sequence = rawId ?? "0";
        const job = await getOwnedJob(pool, request.params.jobId, session.user.id);
        if (!job) httpError(404);

        const closed = new AbortController();
        request.raw.once("close", () => closed.abort());
        async function* events(): AsyncGenerator<string> {
          while (!closed.signal.aborted) {
            const batch = await listOwnedJobEvents(
              pool,
              request.params.jobId,
              session!.user.id,
              sequence,
            );
            if (!batch) return;
            for (const event of batch) {
              sequence = event.id;
              yield encodeEvent(event);
            }
            const current = await getOwnedJob(pool, request.params.jobId, session!.user.id);
            if (!current || terminal.has(current.status)) return;
            await delay(250, undefined, { signal: closed.signal }).catch(() => undefined);
          }
        }

        return reply
          .headers({
            "cache-control": "no-cache, no-store",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            "x-accel-buffering": "no",
          })
          .send(Readable.from(events()));
      },
    );
  };
