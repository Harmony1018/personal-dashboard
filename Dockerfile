FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/app/data
EXPOSE 4173
VOLUME ["/app/data"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
CMD ["node", "server.mjs"]
