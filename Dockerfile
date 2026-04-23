FROM node:18-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:18-alpine AS production

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache postgresql-client curl \
  && npm install -g pm2@5.4.3 \
  && npm cache clean --force

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

RUN sed -i 's/\r$//' docker/entrypoint.sh \
  && chmod +x docker/entrypoint.sh

USER node

ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
CMD ["pm2-runtime", "ecosystem.config.js"]
