FROM node:24-alpine AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/cli ./packages/cli
COPY apps/docs/package.json ./apps/docs/package.json
COPY scripts ./scripts
COPY docs ./docs
COPY README.md LICENSE NOTICE ./
RUN pnpm install --frozen-lockfile && pnpm build:cli

FROM node:24-alpine
WORKDIR /app
COPY --from=build --chown=node:node /build/packages/cli/package.json ./
COPY --from=build --chown=node:node /build/packages/cli/LICENSE /build/packages/cli/NOTICE ./
COPY --from=build --chown=node:node /build/packages/cli/dist ./dist
COPY --from=build --chown=node:node /build/packages/cli/skills ./skills
COPY --from=build --chown=node:node /build/packages/cli/docs ./docs
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/bin/noknok.js"]
CMD ["server", "--host", "0.0.0.0"]
