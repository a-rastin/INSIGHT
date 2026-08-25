ARG NODE_IMAGE=node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b
ARG POSTGRES_IMAGE=postgres:16.10-bookworm@sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/tsconfig.json apps/server/tsconfig.build.json apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.build.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json packages/contracts/
COPY packages/bayes/package.json packages/bayes/tsconfig.json packages/bayes/tsconfig.build.json packages/bayes/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/server/src apps/server/src
COPY apps/web/src apps/web/src
COPY packages/contracts/src packages/contracts/src
COPY packages/bayes/src packages/bayes/src
RUN npm run build --workspace @insight/contracts \
 && npm run build --workspace @insight/server \
 && npm run build --workspace @insight/web

FROM ${NODE_IMAGE} AS runtime-dependencies
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/bayes/package.json packages/bayes/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @insight/server

FROM ${NODE_IMAGE} AS node-runtime

FROM ${POSTGRES_IMAGE} AS production
LABEL org.opencontainers.image.title="INSIGHT" \
      org.opencontainers.image.description="INSIGHT all-in-one research deployment"

RUN groupadd --gid 10001 insight \
 && useradd --uid 10001 --gid insight --groups postgres --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin insight \
 && install -d -o insight -g insight -m 0750 /opt/insight /run/insight \
 && install -d -o postgres -g postgres -m 0750 /var/lib/insight

WORKDIR /opt/insight
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-dependencies /build/node_modules node_modules
COPY --from=build /build/.tsbuild/server .tsbuild/server
COPY --from=build /build/apps/web/dist apps/web/dist
COPY --from=build /build/packages/contracts/dist packages/contracts/dist
COPY --from=build /build/packages/bayes/dist packages/bayes/dist
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/bayes/package.json packages/bayes/package.json
COPY --chmod=0755 container/entrypoint.sh /usr/local/bin/insight-entrypoint

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    INSIGHT_STATIC_ROOT=/opt/insight/apps/web/dist \
    INSIGHT_VOLUME=/var/lib/insight \
    INSIGHT_ARTIFACT_ROOT=/var/lib/insight/artifacts \
    INSIGHT_BACKUP_ROOT=/var/lib/insight/backups \
    INSIGHT_APP_VERSION=0.1.0 \
    INSIGHT_WORKER_READY_FILE=/run/insight/worker-ready \
    DATABASE_URL=postgresql://insight@localhost/insight?host=%2Frun%2Fpostgresql

EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/insight-entrypoint"]
