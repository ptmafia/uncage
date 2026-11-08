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

WORKDIR /repo/examples/connected-demo
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3200 \
    DEMO_DATA_DIR=/data \
    TRUST_PROXY=1
EXPOSE 3200
CMD ["node", "server.ts"]
