FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && addgroup -S lyraflow && adduser -S lyraflow -G lyraflow
COPY --from=build /app /app
RUN pnpm install --frozen-lockfile --prod
USER lyraflow
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
