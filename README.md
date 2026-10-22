# Distributed Wagering Processor

Solução do [desafio técnico de backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

Serviço que processa transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de vários provedores, por HTTP e por uma fila SQS FIFO. O saldo de cada wallet fica consistente com um ledger imutável mesmo com mensagens duplicadas, fora de ordem e várias instâncias processando a mesma wallet ao mesmo tempo.

Stack: Bun 1.4, TypeScript estrito, NestJS 11, PostgreSQL 17, MikroORM 6, SQS no LocalStack e Docker Compose.

As decisões de projeto, os trade-offs e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Destaques

As quatro garantias que o desafio exige valem nesses cenários: nenhum crédito ou débito em dobro, saldo nunca negativo, saldo sempre igual ao reconstruído pelo ledger e nenhum evento confirmado perdido. Os testes reproduzem as falhas de verdade, por exemplo:

- três processos da aplicação sobre o mesmo banco, um deles morto com `kill -9` no meio da carga, e cada wallet termina com o saldo exato esperado;
- a mesma aposta enviada 50 vezes em paralelo gera um único débito;
- um worker morto com `SIGKILL` entre o commit e o ack da fila não duplica a operação quando a mensagem volta.

As regras críticas também estão no schema, em constraints e triggers: um bug no código esbarra no banco antes de corromper um saldo. Os 238 testes de integração rodam contra PostgreSQL e SQS reais, sem mock de banco nem de fila, ao lado de 148 testes de unidade. A CI no GitHub Actions repete tudo num Ubuntu limpo a cada push e termina com o stack de três réplicas no ar.

## Subir com Docker

Precisa de Docker com o Compose v2.

```bash
docker compose up --build --scale app=3
```

Sobem estes serviços:

| Serviço | O que é | Porta no host |
|---|---|---|
| `gateway` | nginx distribuindo entre as réplicas da app | 3000 |
| `app` | a aplicação (3 réplicas com `--scale app=3`) | só pelo gateway |
| `migrate` | roda as migrations uma vez e termina, antes das réplicas | |
| `postgres` | PostgreSQL 17 | 5433 |
| `localstack` | SQS (LocalStack 4.14.0) com as filas já criadas | 4566 |

O Postgres fica na 5433 para não colidir com um Postgres instalado na máquina. O LocalStack está fixo na 4.14.0 porque as versões a partir de 2026.03 exigem token.

Cada réplica roda a API HTTP, o consumidor SQS, o relay da outbox e o worker de referências pendentes. Toda resposta traz o header `X-Instance`, que diz qual réplica atendeu.

## Exemplo rápido

```bash
# cria a wallet com saldo inicial (gera a transação interna OPENING)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Com o `id` devolvido no lugar de `WALLET_ID`:

```bash
curl -s -i -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

A primeira chamada responde 201 com `"idempotentReplay": false`. Repetir o mesmo comando responde 200 com o mesmo corpo e `"idempotentReplay": true`, sem debitar de novo.

Os exemplos usam ids fixos. Rodá-los de novo no mesmo banco com outra wallet dá 409, porque o `playerId` já tem wallet e a `Idempotency-Key` já foi usada com outro payload. Para começar do zero, `docker compose down -v` apaga o volume do Postgres.

```bash
curl -s localhost:3000/wallets/WALLET_ID/ledger
curl -s -X POST localhost:3000/wallets/WALLET_ID/reconciliation
```

Para mandar a mesma operação pela fila:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_ID --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-10-21T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"40.00","currency":"BRL"}}}'
```

Os eventos de integração publicados pela outbox vão para a fila `wagering-events.fifo`.

## Endpoints

| Método e rota | Para quê |
|---|---|
| `POST /wallets` | cria a wallet; duplicada para o mesmo `playerId` + moeda é 409 |
| `GET /wallets/:walletId` | saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | lançamentos em ordem, com cursor opaco (limite de 1 a 200) |
| `POST /wallets/:walletId/reconciliation` | compara o saldo gravado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | submete uma operação; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live` | o processo está de pé (não consulta nada) |
| `GET /health/ready` | Postgres e filas alcançáveis |
| `GET /metrics` | métricas no formato Prometheus |

Status HTTP de `POST /wagering/transactions`:

| Status | Quando | O que o provedor faz |
|---|---|---|
| 201 | processada agora | segue |
| 200 | replay de uma já processada | segue (é o resultado original) |
| 202 | esperando a transação referenciada (`PENDING_REFERENCE`) | consulta de novo depois do `Retry-After` |
| 400 | payload inválido | corrige antes de reenviar |
| 404 | wallet inexistente | não reenvia igual |
| 409 | `Idempotency-Key` já usada com outro conteúdo, ou `externalTransactionId` já enviado com outra chave | não reenvia igual |
| 413 | body acima de 100 KB | não reenvia igual |
| 422 | terminal: rejeitada por regra de negócio (`REJECTED`) ou falha permanente (`FAILED`) | lê o `failureCode`; reenviar devolve o mesmo resultado |
| 503 | infraestrutura indisponível (banco, lock, pool) | reenvia com a mesma `Idempotency-Key` depois do `Retry-After` |

Erros saem sempre com `{ "code": "...", "message": "..." }`; o 409 de wallet duplicada traz também o `walletId` existente. Os códigos de falha (`failureCode`) estão listados no ARCHITECTURE.md.

## Rodar local e testar

Precisa do Bun 1.4.3 e dos containers de Postgres e LocalStack.

```bash
cp .env.example .env
```

```bash
docker compose up -d postgres localstack
```

```bash
bun install
```

```bash
bun run typecheck
```

```bash
bun run test
```

```bash
bun run test:integration
```

A CI (`.github/workflows/ci.yml`) roda esses mesmos passos a cada push, num Ubuntu limpo, e no fim sobe o stack completo com três réplicas.

`bun run test` roda os testes de unidade. `bun run test:integration` roda os de integração contra o Postgres e o LocalStack reais, em cerca de 2 minutos. Eles usam um banco próprio, `wagering_test`, que cada arquivo de teste recria do zero rodando as migrations. Os testes de fila criam as próprias filas no LocalStack; só o de configuração lê as filas do `init-sqs.sh`. Os testes de vários processos sobem a app de verdade em processos filhos.

Para rodar a app fora do Docker (com os containers de Postgres e LocalStack de pé):

```bash
bun run migrate:up
```

```bash
bun run dev
```

### Onde estão os testes obrigatórios da seção 13

| Cenário | Arquivo |
|---|---|
| Money: escala, entradas inválidas, conflito de moeda | `test/unit/money.test.ts` |
| invariantes da Wallet e do lançamento | `test/unit/wallet.test.ts`, `test/unit/wallet-ledger-entry.test.ts` |
| regras de BET, WIN, LOSS, REFUND, ROLLBACK | `test/unit/wager-transaction.test.ts`, `test/integration/wagering.test.ts` |
| idempotency key com payload divergente | `test/unit/payload-hash.test.ts`, `test/integration/wagering.test.ts`, `test/integration/http-api.test.ts` |
| migrations (sobem, descem e sobem de novo) e constraints | `test/integration/migrations.test.ts`, `test/integration/wallet-schema.test.ts` |
| atomicidade entre wallet, ledger, inbox e outbox | `test/integration/outbox.test.ts`, `test/integration/sqs-consumer.test.ts` |
| inbox e redelivery, retry e DLQ | `test/integration/sqs-consumer.test.ts` |
| publishers concorrentes na mesma outbox | `test/integration/outbox.test.ts`, `test/integration/multi-process.test.ts` |
| a mesma aposta 50 vezes em paralelo | `test/integration/wagering.test.ts` (um processo), `test/integration/multi-process.test.ts` (três) |
| 100.00 com duas apostas simultâneas de 80.00 | `test/integration/wallet-concurrency.test.ts`, `test/integration/multi-process.test.ts` |
| wallets distintas em paralelo | `test/integration/wallet-concurrency.test.ts` |
| três processos simultâneos | `test/integration/multi-process.test.ts` |
| worker morto depois do commit e antes do ack | `test/integration/sqs-consumer.test.ts` |
| REFUND ou ROLLBACK antes da referência | `test/integration/pending-reference.test.ts`, `test/integration/multi-process.test.ts` |
| reinício do serviço com consistência final | `test/integration/restart.test.ts` (`kill -9` em um dos três processos no meio da carga) |

Todo arquivo de integração termina conferindo, em todas as wallets do banco, que o saldo gravado é igual ao saldo reconstruído pelo ledger (`test/integration/support/invariant.ts`).

## Configuração

As variáveis estão em `.env.example`. As que mudam comportamento:

| Variável | Padrão | Efeito |
|---|---|---|
| `OUTBOX_RELAY_ENABLED` | `true` | liga o relay que publica a outbox |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor de `wager-transactions.fifo` |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de `PENDING_REFERENCE` |
| `SQS_CONSUMER_CONCURRENCY` | `5` | leitores em paralelo no consumidor |
| `WALLET_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock de uma wallet; passou disso, 503 ou retry |
| `DATABASE_ACQUIRE_TIMEOUT_MS` | `5000` | espera máxima por uma conexão livre do pool |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | duração máxima de uma consulta |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `30000` | tempo máximo parado dentro de uma transação; passou disso, o Postgres encerra a sessão e solta os locks |
| `DATABASE_POOL_MAX` | `10` | conexões por instância |

As URLs de fila só são exigidas quando o componente que as usa está ligado.

## Estrutura

```
src/
  domain/          Money, Wallet, WalletLedgerEntry, WagerTransaction, eventos, inbox e outbox
  application/     use cases, worker de pendentes, relay da outbox, consultas, classificação de erros
    ports/         interfaces que a aplicação usa para falar com banco, relógio e métricas
  infrastructure/  implementação das portas: MikroORM e migrations, SQS, logs e métricas
    wiring.ts      raiz de composição: liga cada porta à implementação real
  interfaces/http/ controllers, filtro de erros, correlation id, guard de autenticação (no-op)
  health/          liveness e readiness
test/
  unit/            sem banco nem fila: domínio, hash, logger, backoff e a regra de dependência entre camadas
  integration/     Postgres e LocalStack reais, vários processos
docker/            nginx e script de criação das filas
```
