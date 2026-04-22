FROM node:18-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:18-alpine AS production

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

RUN chmod +x docker/entrypoint.sh

USER node

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["npm", "run", "start:indexer"]
