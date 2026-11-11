# Toolchain image for building and testing the AI_Discovery_Loop packages (discovery-loop spec, D1, R20.10).
# Node.js runs only inside this container; nothing is installed on the host.
#
# NOT BUILT YET: building requires an approved `docker build` (which pulls the base image).
# The base image is pinned by index digest; see docs/version-pinning.json (status: candidate_observed).
#
# Intended use (each run needs its own approval):
#   install:  docker run --rm -v <repo>:/workspace -v phoenix-node-modules:/workspace/node_modules <image> npm ci
#             (network: npm registry only)
#   build/test: same mounts, plus --network none (except the approved Test API integration tests)
# node_modules lives in a named volume, not on the Windows bind mount.

FROM docker.io/library/node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

# Fail the build if the image does not contain the pinned Node.js and npm versions.
RUN test "$(node --version)" = "v26.13.0" \
 && test "$(npm --version)" = "11.20.0"

# Unprivileged build user (uid/gid 10001), separate from the image's default "node" user.
RUN groupadd --gid 10001 phoenix \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin phoenix \
 && mkdir -p /workspace \
 && chown 10001:10001 /workspace

# The build user has no home directory; npm cache and HOME live in /tmp (a tmpfs or the container layer, never a bind mount).
ENV NODE_ENV=development \
    HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /workspace
USER 10001:10001

# No default command: the caller states the command explicitly (npm ci, npm run build, npm test).