# Container image for Smart Forms Health Links: one Node process serving the built SPA, the BFF
# API and the public SHL routes from a single origin.
#
# Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation
# (CSIRO) ABN 41 687 119 230.
#
# Build:
#
#   docker build -t smart-forms-health-links:latest .
#
# Run. APP_ORIGIN and SESSION_COOKIE_SECRET have no defaults, and the credentials the issuer
# registry names by `env:VARIABLE_NAME` reference must be present too. The registry itself is
# mounted read-only, and /data holds the SQLite file:
#
#   docker run --rm -p 3000:3000 \
#     -e APP_ORIGIN=http://localhost:3000 \
#     -e SESSION_COOKIE_SECRET="$SESSION_COOKIE_SECRET" \
#     -e LAUNCH_CLIENT_SECRET="$LAUNCH_CLIENT_SECRET" \
#     -e BACKEND_PRIVATE_JWK="$BACKEND_PRIVATE_JWK" \
#     -v "$PWD/config/issuers.json:/etc/smart-forms-health-links/issuers.json:ro" \
#     -v smart-forms-health-links-data:/data \
#     smart-forms-health-links:latest
#
# @author John Grimes

# ---------------------------------------------------------------------------------------------
# Build stage. The full node:22 image rather than the slim one, because `npm ci` compiles
# better-sqlite3 from source whenever no prebuilt binary matches the target platform, and that
# needs the toolchain the slim image leaves out.
# ---------------------------------------------------------------------------------------------
FROM node:22 AS build

WORKDIR /app

# The manifest and lockfile alone, so editing a source file does not invalidate the install
# layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `build` type-checks the whole repository and emits the SPA into dist/. `build:server` bundles
# the BFF into dist-server/index.mjs with its dependencies left external, which is why the
# production node_modules travels to the runtime stage. `npm prune` then drops the dev
# dependencies from that tree, leaving the better-sqlite3 binary this install produced.
#
# The bundle imports five packages - fastify, @fastify/cookie, @fastify/static, better-sqlite3
# and jose - but the pruned tree is the whole of `dependencies`, so it also carries the SPA's
# React and MUI stack that only the build needed. That is most of the image's size. Trimming it
# means either walking the five packages' dependency closure or reinstalling them outside the
# lockfile, and neither is worth losing the lockfile's pinning over.
RUN npm run build \
  && npm run build:server \
  && npm prune --omit=dev

# ---------------------------------------------------------------------------------------------
# Runtime stage. node:22-slim is the same Debian bookworm and glibc as the build stage, so the
# better-sqlite3 binary copied across loads without a rebuild.
# ---------------------------------------------------------------------------------------------
FROM node:22-slim AS runtime

# Defaults for the paths this image fixes. APP_ORIGIN, SESSION_COOKIE_SECRET and the registry's
# named credentials are deliberately absent: the server refuses to start without them.
ENV NODE_ENV=production \
  PORT=3000 \
  SQLITE_PATH=/data/links.sqlite \
  ISSUER_REGISTRY_PATH=/etc/smart-forms-health-links/issuers.json

# An init process, so that the server is not PID 1. Node installs no SIGTERM handler of its
# own, and PID 1 ignores signals whose disposition is the default: without this the container
# runs until the grace period expires and is then killed (exit 137), which makes every
# Kubernetes rollout wait out `terminationGracePeriodSeconds`. tini reaps and forwards, and
# node - no longer PID 1 - exits on SIGTERM (143). The SQLite write-ahead log is crash-safe, so
# an abrupt stop costs at most the requests in flight.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

WORKDIR /app

# The only writable path: the SQLite file and its write-ahead log sidecars. Owned by the
# unprivileged `node` user this container runs as. Mount a volume here or the minted links die
# with the container.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# An empty registry, so the server starts and answers /health even before a real one is mounted
# over this path. Every launch is refused until one is.
RUN mkdir -p /etc/smart-forms-health-links \
  && echo '[]' > /etc/smart-forms-health-links/issuers.json

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

USER node
EXPOSE 3000

# Node 22 has a global fetch, so the probe needs nothing installed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"

# The bundle resolves the SPA relative to itself (`../dist`), so it must stay at /app.
CMD ["node", "/app/dist-server/index.mjs"]
