FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/votes.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js geo.js store.js postgres.js sheets.js games.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
