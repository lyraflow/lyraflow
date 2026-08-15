FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
# packages/ui/src/styles/theme.css imports brand/tokens.css, the single
# generated source of colour for the interface. That import resolves fine in
# a checkout but crosses outside packages/, so without this line `pnpm build`
# fails inside the image on a path that looks perfectly normal on disk. This
# is build-stage only: Vite inlines/emits everything theme.css pulls in
# (fonts, the token values themselves) into packages/ui/dist at build time,
# so nothing at runtime ever reads from brand/ again. Load-bearing -- do not
# trim it as dead weight.
COPY brand ./brand
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && addgroup -S lyraflow && adduser -S lyraflow -G lyraflow
COPY --from=build /app /app
RUN pnpm install --frozen-lockfile --prod
USER lyraflow
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
