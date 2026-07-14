FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.144.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}"

COPY .github/scripts/run-codex-review.sh /usr/local/bin/run-codex-review.sh
COPY .github/codex-review.schema.json /opt/codex-review/schema.json

WORKDIR /workspace

ENTRYPOINT ["bash", "/usr/local/bin/run-codex-review.sh"]
