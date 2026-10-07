# syntax=docker/dockerfile:1
# Imagem única da aplicação; o papel do processo vem de APP_ROLE (api|consumer|outbox|reprocessor|all).
# O Bun executa o TypeScript direto (sem etapa de build), então a imagem leva src/, scripts/ e migrations/.
ARG BUN_IMAGE=oven/bun:1

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bunfig.toml tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun migrations ./migrations
# Usuário não-root que já existe na imagem oficial do Bun.
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 CMD ["bun", "scripts/healthcheck.ts"]
CMD ["bun", "src/main.ts"]
