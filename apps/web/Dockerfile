# Assessify web — Next.js App Router (docs/spec/03-architecture.md).
# Build context is the MONOREPO ROOT (workspace packages are referenced via
# `workspace:*` and Next's `transpilePackages`, so the whole tree is needed):
#   docker build -f apps/web/Dockerfile -t assessify-web .
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @assessify/web build

FROM node:24-slim AS runtime
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 3000
CMD ["pnpm", "--filter", "@assessify/web", "start"]
