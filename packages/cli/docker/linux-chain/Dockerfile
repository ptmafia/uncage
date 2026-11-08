# The Linux full chain, part 1: a computer with no Node at all (curl, CA certificates, unzip only).
# install.sh (served by the real hub) installs Node 22 through fnm and the CLI from the local
# tarballs, then setup, the agent and a codex run (testkit fake) are checked. The hub runs in the
# `hub` stage below, in its own container whose network namespace this one joins.
FROM debian:bookworm-slim AS chain
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates unzip procps \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash u
COPY pkgs/ /pkgs/
COPY fake-codex.js /opt/fake-codex/fake-codex.js
COPY codex /usr/local/bin/codex
COPY run.sh /opt/run.sh
RUN chmod 755 /usr/local/bin/codex /opt/run.sh && chmod -R a+rX /pkgs /opt/fake-codex
USER u
WORKDIR /home/u
ENV SHELL=/bin/bash
CMD ["/opt/run.sh"]

# The real hub (createHub + pgliteHubStore + attachWebSocket) from the local @uncage/hub tarball.
FROM node:22-bookworm-slim AS hub
COPY pkgs/ /pkgs/
WORKDIR /opt/hub
RUN echo '{"name":"chain-hub","private":true,"type":"module"}' > package.json \
  && npm install --no-audit --no-fund --omit=dev /pkgs/uncage-hub.tgz
COPY hub.mjs /opt/hub/hub.mjs
EXPOSE 3000
CMD ["node", "/opt/hub/hub.mjs"]
