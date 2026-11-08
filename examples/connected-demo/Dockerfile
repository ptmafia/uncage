# The connected demo as one container: the Next.js site, the Uncage hub and the machines'
# WebSocket on a single port (server.ts). Build from the repository root:
#
#   docker build -f examples/connected-demo/Dockerfile -t uncage-connected-demo .
#   docker run -p 3200:3200 -e PUBLIC_URL=http://localhost:3200 -v uncage-demo:/data uncage-connected-demo
#
# Railway / Render set PORT and their public domain; see examples/connected-demo/DEPLOY.md.
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
RUN corepack enable

WORKDIR /repo
COPY . .
# The demo and the workspace packages it uses (plus the root's build tools), nothing else.
RUN pnpm install --frozen-lockfile --filter "connected-demo..." --filter uncage \
 && pnpm exec turbo run build --filter="connected-demo..." \
 && pnpm store prune

# Runs as the image's unprivileged `node` user. It owns /data (the default DEMO_DATA_DIR) and Next's
# runtime cache, and only reads the other app files. A mounted volume must be writable by uid 1000.
RUN mkdir -p /data /repo/examples/connected-demo/.next/cache \
 && chown node:node /data \
 && chown -R node:node /repo/examples/connected-demo/.next/cache

WORKDIR /repo/examples/connected-demo
# Per-IP rate limits use the socket address unless you set TRUST_PROXY=1 or CLIENT_IP_HEADER, and
# only behind a proxy that sets that header (see DEPLOY.md). A bare `docker run` needs neither.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3200 \
    DEMO_DATA_DIR=/data
USER node
EXPOSE 3200
CMD ["node", "server.ts"]
