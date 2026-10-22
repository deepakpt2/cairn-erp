FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_OPTIONS=--max-old-space-size=2048 \
    npm_config_update_notifier=false

RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sudo git openssh-server openssh-sftp-server iproute2 \
      python3 make g++ \
    && install -d /usr/share/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/cairn-prereq
COPY package.json package-lock.json ./
RUN npm ci \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /opt/cairn-prereq/node_modules /root/.npm

RUN if id node >/dev/null 2>&1; then \
      usermod -l cairn -d /home/cairn -m node && groupmod -n cairn node; \
    else \
      useradd --create-home --shell /bin/bash --uid 1000 cairn; \
    fi \
    && echo 'cairn ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/cairn \
    && chmod 440 /etc/sudoers.d/cairn \
    && install -d -o cairn -g cairn /work /var/run/sshd

COPY docker/sshd_config /etc/ssh/sshd_config.build-box
COPY docker/bootstrap-db.mjs /usr/local/bin/bootstrap-db.mjs
COPY docker/entrypoint.sh /usr/local/bin/build-box-entrypoint
RUN chmod 755 /usr/local/bin/build-box-entrypoint /usr/local/bin/bootstrap-db.mjs

EXPOSE 2222
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/build-box-entrypoint"]
