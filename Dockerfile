# syntax=docker/dockerfile:1.7
# Canopy images (docs/release.md, docs/deploy.md). One file, three targets:
#   docker buildx build --target gateway|web|worker --build-arg CANOPY_VERSION=1.2.3 --platform linux/amd64,linux/arm64 .
# Builds run on the build platform and cross-compile for TARGETARCH (bun build --compile), so arm64 needs no
# emulation except for the worker's package install.

ARG BUN_VERSION=1.4.4

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts \
      --filter @canopy/gateway --filter @canopy/worker --filter @canopy/web
ARG CANOPY_VERSION=0.0.0-dev
ENV CANOPY_VERSION=${CANOPY_VERSION}

FROM build AS gateway-build
ARG TARGETARCH
RUN bun scripts/build-binaries.ts --app gateway --target "linux-$(echo "$TARGETARCH" | sed s/amd64/x64/)" --outdir /out \
 && mv /out/canopy-gateway-* /out/canopy-gateway

FROM build AS worker-build
ARG TARGETARCH
RUN bun scripts/build-binaries.ts --app worker --target "linux-$(echo "$TARGETARCH" | sed s/amd64/x64/)" --outdir /out \
 && mv /out/canopy-worker-* /out/canopy-worker

FROM build AS web-build
RUN bun scripts/build-web.ts --outdir /out/web

# Gateway: gRPC (HTTP/2) for workers and the web BFF on 7443. Needs PostgreSQL (CANOPY_DATABASE_URL).
FROM debian:bookworm-slim AS gateway
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
ARG CANOPY_VERSION=0.0.0-dev
ARG CANOPY_REVISION=unknown
LABEL org.opencontainers.image.title="canopy-gateway" \
      org.opencontainers.image.description="Canopy gateway: workers, threads and the API of the web app" \
      org.opencontainers.image.source="https://github.com/itsoltech/canopy" \
      org.opencontainers.image.version="${CANOPY_VERSION}" \
      org.opencontainers.image.revision="${CANOPY_REVISION}"
COPY --from=gateway-build /out/canopy-gateway /usr/local/bin/canopy-gateway
# sharp's native library is extracted on first start; /tmp is writable for the nonroot user.
ENV CANOPY_VERSION=${CANOPY_VERSION} CANOPY_NATIVE_DIR=/tmp/canopy-native CANOPY_HOST=0.0.0.0 CANOPY_PORT=7443
USER 65532:65532
EXPOSE 7443
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/usr/local/bin/canopy-gateway", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/canopy-gateway"]

# Web: the SvelteKit BFF and the SPA on 3000; talks to the gateway (GATEWAY_URL, GATEWAY_SERVICE_TOKEN).
FROM oven/bun:${BUN_VERSION}-distroless AS web
ARG CANOPY_VERSION=0.0.0-dev
ARG CANOPY_REVISION=unknown
LABEL org.opencontainers.image.title="canopy-web" \
      org.opencontainers.image.description="Canopy web app (SvelteKit BFF and SPA)" \
      org.opencontainers.image.source="https://github.com/itsoltech/canopy" \
      org.opencontainers.image.version="${CANOPY_VERSION}" \
      org.opencontainers.image.revision="${CANOPY_REVISION}"
WORKDIR /app
COPY --from=web-build /out/web /app
ENV CANOPY_VERSION=${CANOPY_VERSION} NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=50M GATEWAY_URL=http://gateway:7443
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/bun", "/app/index.js"]

# Worker: runs agent turns with the CLIs it finds on PATH (claude, codex, grok are not included: extend this
# image or mount them, docs/deploy.md). Enrollment, logins and the journal live in the /home/canopy volume.
FROM debian:bookworm-slim AS worker
ARG CANOPY_VERSION=0.0.0-dev
ARG CANOPY_REVISION=unknown
LABEL org.opencontainers.image.title="canopy-worker" \
      org.opencontainers.image.description="Canopy worker (agent CLIs not included)" \
      org.opencontainers.image.source="https://github.com/itsoltech/canopy" \
      org.opencontainers.image.version="${CANOPY_VERSION}" \
      org.opencontainers.image.revision="${CANOPY_REVISION}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --user-group --shell /bin/bash canopy
COPY --from=worker-build /out/canopy-worker /usr/local/bin/canopy-worker
ENV CANOPY_VERSION=${CANOPY_VERSION} CANOPY_WORKER_STATUS_FILE=/tmp/canopy-worker-status.json
USER canopy
WORKDIR /home/canopy
VOLUME ["/home/canopy"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/usr/local/bin/canopy-worker", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/canopy-worker"]
