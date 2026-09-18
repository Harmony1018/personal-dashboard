FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /app/data
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/app/data
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server.mjs"]
