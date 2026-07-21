# Assessify worker — BullMQ processors (docs/spec/03-architecture.md).
# Build context is the MONOREPO ROOT:
#   docker build -f apps/worker/Dockerfile -t assessify-worker .
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@assessify/worker", "start"]
