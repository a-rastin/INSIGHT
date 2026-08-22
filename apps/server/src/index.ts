import Fastify from "fastify";
import type { HealthResponse } from "@insight/contracts";

export const app = Fastify({ logger: false });

app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));
