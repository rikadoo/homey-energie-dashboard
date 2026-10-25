FROM node:24-alpine

LABEL org.opencontainers.image.title="Homey Energie Dashboard" \
      org.opencontainers.image.description="Lokaal energiedashboard voor Homey Pro" \
      org.opencontainers.image.source="https://github.com/rikadoo/homey-energie-dashboard" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache tzdata su-exec \
 && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    TZ=Europe/Amsterdam \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
