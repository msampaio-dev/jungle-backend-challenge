# Mesma versão do Bun usada no desenvolvimento e nos testes.
FROM oven/bun:1.4.3-alpine

WORKDIR /app

# Dependências primeiro (camada em cache enquanto o lockfile não muda).
# --frozen-lockfile: falha se o bun.lock não bater com o package.json.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# tsconfig entra porque o Bun lê dele os decorators (experimentalDecorators
# e emitDecoratorMetadata) que o Nest usa.
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
USER bun

# exec form: o processo do Bun é o PID 1 e recebe o SIGTERM direto
CMD ["bun", "run", "src/main.ts"]
