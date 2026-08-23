# Builds the static site and serves it from nginx.
#
# The app is a single-page app with no server side: the build output is a
# directory of files, and the runtime is a web server that knows two things -
# unknown paths fall through to index.html so client-side routing works, and
# config.json must not be cached, because it is the one file a deployment
# replaces to point the app at different servers.
#
# Author: John Grimes

FROM node:24-alpine AS build

WORKDIR /build

# Dependencies are installed from the lock file alone, so this layer is reused
# whenever only application source has changed.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

RUN npm run build

FROM nginx:1.29-alpine

COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /build/dist /usr/share/nginx/html

# nginx listens on 8080 and runs as the unprivileged `nginx` user, so the
# container needs no root and no added capabilities. The temporary paths it
# writes to are redirected to /tmp by nginx.conf, and the pid file with them,
# which leaves the whole filesystem free to be read-only.
EXPOSE 8080
USER nginx

CMD ["nginx", "-g", "daemon off;"]
