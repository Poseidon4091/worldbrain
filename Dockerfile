# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
# Must run before tsc: the compile depends on the generated client's types.
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node_modules is copied wholesale from the builder rather than reinstalled with --omit=dev.
# `npm prune` would strip the prisma CLI, and the generated client under node_modules/.prisma is
# not a tracked package — pruning risks leaving a client that cannot be regenerated at runtime.
# Costs some image size; buys a runtime that is guaranteed to match what was built.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

# Drop privileges — the node image ships an unprivileged `node` user.
USER node

EXPOSE 8080

# `migrate deploy` applies pending migrations only, and never resets or drops data — the one
# Prisma command that is safe to run unattended on every container start. (It replaced `db push`,
# which infers changes by diffing and can silently drop a column to make the database match.)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/index.js"]
