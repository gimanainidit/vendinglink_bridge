# Stage 1: Build
FROM node:20-alpine AS builder

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
# We must generate the prisma client before compiling TS
RUN npm run db:gen && npx prisma generate --schema=prisma/postgres/schema.prisma
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/docs ./docs

# Generate Prisma Client inside the actual runtime image
RUN npx prisma generate --schema=prisma/postgres/schema.prisma

# Setup a non-root user
USER node

# Healthcheck targeting the Express /health endpoint
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
