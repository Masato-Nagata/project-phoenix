# Runtime image of the AI_Discovery_Loop (`discovery-runtime`, discovery-loop spec D1, R15, R20).
#
# NOT BUILDABLE YET: needs package-lock.json and the packages created in M1-M4, and an approved `docker build`.
# Build context: repository root. The root .dockerignore excludes everything except the files the build needs,
# so evaluation/, tests/, .kiro/, legacy/, docs/, infra/ and .env* can never enter an image layer.
#
# Started only by the host-side Launcher with `docker run` (never by `docker compose up`), with:
#   --network phoenix-discovery-lab --read-only --cap-drop ALL --security-opt no-new-privileges:true
#   --user 10001:10001 --tmpfs /tmp, CPU and memory limits, no published port,
#   and only the mounts listed in design.md (7 source files read-only, configs read-only,
#   the Run's named volume read-write, the lease directory read-only).

ARG BASE_IMAGE=docker.io/library/node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

# ---- build stage ----
FROM ${BASE_IMAGE} AS build
RUN test "$(node --version)" = "v26.13.0" && test "$(npm --version)" = "11.20.0"
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
COPY packages/ ./packages/
RUN npm ci --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts

# ---- runtime stage ----
FROM ${BASE_IMAGE} AS runtime
RUN groupadd --gid 10001 phoenix \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin phoenix
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=build --chown=0:0 /build/package.json ./package.json
COPY --from=build --chown=0:0 /build/node_modules ./node_modules
COPY --from=build --chown=0:0 /build/packages ./packages
LABEL phoenix.discovery.role="runtime"
USER 10001:10001
# Entry point of the Loop_Orchestrator (created in M4).
ENTRYPOINT ["node", "/app/packages/discovery-loop/dist/main.js"]