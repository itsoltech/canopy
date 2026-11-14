# syntax=docker/dockerfile:1.7
# Canopy images (docs/release.md, docs/deploy.md). One file, two targets (the gateway serves the web):
#   docker buildx build --target gateway|worker --build-arg CANOPY_VERSION=1.2.3 --platform linux/amd64,linux/arm64 .
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

# The web is target-independent JavaScript; the gateway binary embeds it (canopy-gateway web).
FROM build AS web-build
RUN bun scripts/build-web.ts --outdir /out/web

FROM web-build AS gateway-build
ARG TARGETARCH
RUN bun scripts/build-binaries.ts --app gateway --target "linux-$(echo "$TARGETARCH" | sed s/amd64/x64/)" --outdir /out \
      --web /out/web \
 && mv /out/canopy-gateway-* /out/canopy-gateway

FROM build AS worker-build
ARG TARGETARCH
RUN bun scripts/build-binaries.ts --app worker --target "linux-$(echo "$TARGETARCH" | sed s/amd64/x64/)" --outdir /out \
 && mv /out/canopy-worker-* /out/canopy-worker

# Gateway: gRPC (HTTP/2) for workers and the BFF on 7443, the web app (BFF and SPA) on 3000; CANOPY_WEB=off for
# headless. Needs PostgreSQL (CANOPY_DATABASE_URL). Updates by a new image tag, never in place.
FROM debian:bookworm-slim AS gateway-base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 canopy \
 && useradd --create-home --uid 65532 --gid 65532 --shell /usr/sbin/nologin canopy \
 && install -d -o 65532 -g 65532 /home/canopy/.cache /home/canopy/.cache/canopy

FROM gateway-base AS gateway
ARG CANOPY_VERSION=0.0.0-dev
ARG CANOPY_REVISION=unknown
LABEL org.opencontainers.image.title="canopy-gateway" \
      org.opencontainers.image.description="Canopy gateway and web app: workers, threads, the BFF and the SPA" \
      org.opencontainers.image.source="https://github.com/itsoltech/canopy" \
      org.opencontainers.image.version="${CANOPY_VERSION}" \
      org.opencontainers.image.revision="${CANOPY_REVISION}"
COPY --from=gateway-build /out/canopy-gateway /usr/local/bin/canopy-gateway
# sharp's native library is extracted on first start; /tmp is writable for the nonroot user. The web listens on every
# container interface: the published port is the boundary. ~/.cache/canopy (web releases, update cache) can be a volume.
ENV HOME=/home/canopy CANOPY_VERSION=${CANOPY_VERSION} CANOPY_INSTALL_KIND=docker CANOPY_NATIVE_DIR=/tmp/canopy-native \
    CANOPY_HOST=0.0.0.0 CANOPY_PORT=7443 CANOPY_WEB_HOST=0.0.0.0 CANOPY_WEB_PORT=3000
USER 65532:65532
EXPOSE 7443 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/usr/local/bin/canopy-gateway", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/canopy-gateway"]

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
ENV CANOPY_VERSION=${CANOPY_VERSION} CANOPY_WORKER_STATUS_FILE=/tmp/canopy-worker-status.json \
    CANOPY_WORKTREES_ROOT=/home/canopy/.local/share/canopy/worktrees
USER canopy
WORKDIR /home/canopy
VOLUME ["/home/canopy"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/usr/local/bin/canopy-worker", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/canopy-worker"]
