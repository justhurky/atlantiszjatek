# Atlantisz elveszett városa – futtatható konténer (pl. Render, Railway, Fly.io vagy saját szerver)
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Csak a futáshoz szükséges függőségek (a tesztekhez való Playwright nem kerül bele)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Írható mappák a mentésnek és a fotóknak; a folyamat nem root felhasználóként fut
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app/data /app/uploads
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1
CMD ["node", "src/server.js"]
