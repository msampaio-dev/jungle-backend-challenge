# Arquitetura

Este documento explica como o serviço garante as invariantes do desafio, por que cada decisão foi tomada e o que ficou de fora. Setup e comandos estão no [README.md](README.md).

## Visão geral

```
provedor ──HTTP──▶ gateway (nginx) ──▶ app ×3 ─┐
provedor ──SQS───▶ wager-transactions.fifo ──▶ │ mesmo use case
                                               ▼
                                      PostgreSQL (fonte da verdade)
                                               │ outbox
                                               ▼
                              relay ──▶ wagering-events.fifo
```

Cada instância roda quatro coisas: a API HTTP, o consumidor da fila, o relay da outbox e o worker de referências pendentes. Todas são seguras com várias instâncias ao mesmo tempo, porque a coordenação acontece no banco: lock de linha por wallet, chaves únicas e `SKIP LOCKED` ou advisory lock nos workers. Nenhuma garantia depende de estado em memória nem da FIFO.

## Camadas

```
interfaces/http  ─▶ application ─▶ domain
infrastructure   ─▶ application ─▶ domain
```

As setas são imports, e o teste `test/unit/architecture.test.ts` confere essa regra no código: o domínio não importa nenhuma outra camada nem framework, e a aplicação não importa infraestrutura nem interfaces.

O domínio (`src/domain`) é TypeScript puro: não importa NestJS nem MikroORM. As classes têm construtor privado e factories estáticas (`create`, `from`, `open`, `rehydrate`). `rehydrate` reconstrói o que veio do banco sem revalidar transições, como pede a seção 6.0.

A camada de aplicação tem os use cases (`ProcessWagerTransactionUseCase`, `CreateWalletUseCase`), os workers, a classificação única de erros (`error-kind.ts`), que a API e o consumidor usam para decidir o que fazer com cada erro, e o contexto da operação (os ids que acompanham os logs). Ela fala com o mundo de fora por portas, em `src/application/ports`, com as duas exceções descritas mais abaixo:

| Porta | Para quê | Implementação |
|---|---|---|
| `WalletRepositoryPort`, `WagerTransactionRepositoryPort`, `OutboxRepositoryPort` | persistência, incluindo o lock da wallet e o aluguel de pendentes | repositórios MikroORM em `infrastructure/database` |
| `ClockPort` | a hora de todas as datas gravadas | relógio do banco (`clock_timestamp()`) |
| `MetricsPort` | fatos de negócio a medir (transação concluída, duplicata, retry) | contadores e histogramas do Prometheus |
| `EventPublisher` | para onde vão os eventos da outbox | SQS |
| `ProviderAuthGuard` | autenticação do provedor (hoje no-op) | |

A infraestrutura implementa as portas e monta tudo em `infrastructure/wiring.ts`, a raiz de composição. Os testes trocam uma peça só, como uma outbox que falha de propósito, com `wageringPorts({ outbox: ... })`. O consumidor SQS chama o mesmo use case que a API, com a gravação da inbox passada como um gancho que roda dentro da transação dele.

O MikroORM continua visível na aplicação, de propósito. As portas de persistência recebem o `EntityManager`, porque ele é a transação: tudo que uma operação grava precisa passar pelo mesmo `em.fork().transactional()`. Tirar isso da aplicação exigiria uma porta de Unit of Work só para esconder o ORM que o próprio desafio indica, e a troca de ORM não é um cenário deste serviço.

Duas exceções às portas, conscientes:

- O lado de leitura (`application/queries/wallet-queries.ts`) consulta o banco em SQL direto. As consultas não mudam estado nem têm regra de negócio a proteger, e a reconciliação usa uma função de janela (`lag()`) para conferir o encadeamento do ledger, que ficaria escondida atrás de um repositório. O teste de arquitetura permite SQL só nessa pasta: toda escrita passa pelos repositórios.
- Os use cases reconhecem pelo nome da constraint quando um `INSERT` perdeu uma corrida (`wager_tx_idempotency_uq`, `wager_tx_external_id_uq`, `wallets_player_currency_uq`), para transformar isso em replay ou em 409. Isso acopla a regra aos nomes do schema. O próximo passo seria o repositório traduzir a violação num erro da aplicação.

## ORM e estratégia transacional

Usei o MikroORM 6, a opção preferencial do desafio. Cada operação abre um `em.fork().transactional()`, e tudo que ela grava (transação, saldo, lançamento, inbox e eventos) entra nessa única transação SQL. O `fork` dá a cada operação o seu próprio Identity Map, então duas requisições na mesma instância não compartilham estado.

O lock da wallet usa `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) com `refresh: true`, para ler a linha do banco e não do cache. As escritas que precisam de condição vão em SQL explícito pelo `EntityManager`: o update do saldo com `WHERE version = ?`, o aluguel de pendentes e o claim da outbox. Assim a condição fica visível no código, em vez de depender do flush do Unit of Work.

O domínio não conhece o ORM. Os registros de banco (`records.ts`) são mapeados com `EntitySchema`, sem decorators, e os repositórios convertem entre registro e entidade de domínio. `Money` vira duas colunas, `NUMERIC(18,2)` para o valor e `CHAR(3)` para a moeda. Na leitura, o tipo `decimal` do MikroORM entrega o valor como string, e o repositório o transforma em `Money`; o lado de leitura faz o mesmo com `::text` no SQL. Em nenhum caminho o valor passa por `number`.

As migrations são versionadas, ficam numa lista explícita em `mikro-orm.config.ts` e todas têm `down`. O teste `migrations.test.ts` sobe todas num banco vazio, desce até zero, confere que não sobrou tabela nem função e sobe de novo. No Docker elas rodam uma vez no serviço `migrate`, antes das réplicas, para três instâncias não tentarem criar as mesmas tabelas ao mesmo tempo.

## Money

O valor é guardado em centavos como `bigint`. O desafio só soma, subtrai e compara, então nunca há arredondamento: um valor com mais de 2 casas é recusado na entrada, nunca arredondado.

A entrada aceita `^(0|[1-9]\d{0,15})(\.\d{1,2})?$` e uma moeda `^[A-Z]{3}$`. Isso recusa sinal, espaço, notação científica, `NaN`, `Infinity`, string vazia, zero à esquerda e mais de 2 casas. O limite de 16 dígitos inteiros é o que cabe em `NUMERIC(18,2)`. Uma soma de valores válidos que passaria desse limite vira a rejeição `BALANCE_LIMIT_EXCEEDED`, em vez de erro de banco.

Uma interpretação: a entrada aceita `"25"` e `"25.5"`, e a saída sai sempre com 2 casas (`"25.00"`, `"25.50"`). O hash de idempotência usa o valor normalizado, então `"25"` e `"25.00"` são o mesmo payload. Exigir exatamente 2 casas na entrada seria uma linha no padrão.

Operações entre moedas diferentes lançam `CurrencyMismatchError`. O desafio permite assumir só BRL; o modelo continua multimoeda (uma wallet por jogador e moeda) e os conflitos de moeda são testados.

## WagerTransaction e transições

```
PENDING ──────────▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
PROCESSED, REJECTED, FAILED: terminais
```

Tentar mudar uma transação terminal lança `InvalidTransactionStateError` no domínio e é recusado de novo por um trigger no banco. Na prática nenhuma transação fica gravada em `PENDING`: ela é criada e resolvida dentro da mesma transação SQL, e só o resultado vai para o banco.

`FAILED` só acontece no worker de pendentes. Se resolver uma pendente der erro não transitório 5 vezes (bug ou dado inesperado), ela vira `FAILED` com `PROCESSING_FAILED`, é publicado um `WagerTransactionFailed` e o erro fica em `last_error` para auditoria. Erro transitório (banco fora, failover, pool cheio) não conta para esse limite.

`OPENING` é interno: a API e a fila recusam esse `kind`. As OPENING são gravadas com `providerId` `internal`, e esse id também é recusado vindo de fora, para nenhum provedor dividir com elas as chaves únicas.

## Concorrência

A unidade de concorrência é a wallet. Toda operação que mexe no saldo trava a linha da wallet com `SELECT ... FOR UPDATE` dentro da transação, e daí em diante tudo que toca aquela wallet é serial. Wallets diferentes seguem em paralelo, porque não há lock global.

Escolhi lock pessimista em vez de optimistic locking com retry. Numa wallet disputada (um jogador apostando rápido, um provedor reenviando em rajada), o otimista faria a maioria das tentativas falhar e repetir, e o número de repetições cresce com a disputa. Com o lock, cada operação espera a anterior terminar, e a espera é curta porque a transação só faz algumas consultas no próprio banco, sem chamada externa no meio.

A `version` continua existindo e é uma segunda proteção: o update do saldo leva `WHERE id = ? AND version = ?`, e se nenhuma linha for afetada a transação aborta (`StaleWalletVersionError`) em vez de sobrescrever. Com o lock isso não deveria acontecer; se acontecer, é bug, e o banco recusa. A `version` começa em 1 e só incrementa quando o saldo muda: LOSS e rejeições não mexem nela.

O lock não espera para sempre. `SET LOCAL lock_timeout` (5s, `WALLET_LOCK_TIMEOUT_MS`) faz o Postgres desistir com `55P03`, que vira erro transitório: 503 na API, retry na fila. A espera por uma conexão livre do pool tem o mesmo limite (`DATABASE_ACQUIRE_TIMEOUT_MS`), em vez dos 60s padrão do knex.

As conexões da app também têm limites de sessão no Postgres: `statement_timeout` de 15s, para nenhuma consulta ficar pendurada, e `idle_in_transaction_session_timeout` de 30s. O segundo protege a wallet de uma instância congelada no meio de uma transação (pausa longa, máquina travada): o Postgres encerra a sessão parada, o lock é solto e as próximas operações seguem. Os dois erros (`57014` e `25P03`) são transitórios. O limite de 30s fica acima do pior caso do relay, que segura uma transação por até cerca de 7s. As conexões do serviço `migrate` ficam sem esses limites, porque uma migration longa não pode ser cortada no meio.

Todo caminho que muda saldo ou estado de uma transação (o use case, o worker de pendentes e a desistência do worker) trava a wallet antes de qualquer outra coisa, e nenhum deles trava duas wallets na mesma transação. Por isso não há ciclo de espera entre eles.

## Garantias no schema

As garantias da seção 6 estão no banco, além do código:

| Garantia | Como |
|---|---|
| uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` e em `balance_before`/`balance_after` do ledger |
| lançamento com a conta certa | `CHECK` de `balance_after = balance_before ± amount` conforme a direção |
| moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency)` → `wallets (id, currency)` |
| lançamento é da wallet da transação | FK composta `(transaction_id, wallet_id)` → `wager_transactions (id, wallet_id)` |
| no máximo um lançamento por transação | `UNIQUE (wallet_id, transaction_id)` no ledger |
| ledger imutável | triggers que recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| uma única reversão por referência | índice único parcial em `reference_transaction_id` onde `status = 'PROCESSED'` e `kind` é REFUND ou ROLLBACK |
| transação terminal não muda | trigger que recusa update de linha terminal e de qualquer campo de negócio |
| transações nunca apagadas | triggers que recusam `DELETE` e `TRUNCATE` |
| código de falha só onde faz sentido | `CHECK` de que REJECTED e FAILED têm `failure_code` e os outros estados não |
| evento publicado não muda | trigger na outbox |
| identificadores com tamanho máximo | `CHECK (char_length(...) <= 255)`; sem isso, um texto de alguns KB estourava o índice B-tree e virava 500 |

Mesmo que a idempotência falhasse no código, o débito duplicado seria recusado pela unicidade do lançamento por transação e pelas chaves únicas da transação.

## Idempotência

O header `Idempotency-Key` é obrigatório e é a fonte da verdade. A chave vale por provedor: a unicidade é `(provider_id, idempotency_key)`. O padrão recomendado é `{providerId}:{externalTransactionId}`, mas qualquer chave serve.

O `payloadHash` é SHA-256, em hex, do JSON canônico (chaves em ordem alfabética em todos os níveis, campos ausentes omitidos) destes campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. Os UUIDs entram em minúsculas e o `money` normalizado. O header, o `correlationId`, o `messageId` e o `occurredAt` da mensagem ficam fora, porque são dados de transporte e podem mudar entre reenvios da mesma operação.

O fluxo, todo dentro de uma transação SQL:

1. procura a chave sem lock (o replay comum não espera a wallet);
2. trava a wallet;
3. procura a chave de novo, porque outra requisição pode ter gravado enquanto esta esperava o lock;
4. se o `externalTransactionId` já existe com outra chave, é 409;
5. processa e grava.

Chave igual com hash igual é replay e devolve o resultado original, inclusive o saldo observado naquele momento (`result_balance`). Chave igual com hash diferente é 409 `IDEMPOTENCY_CONFLICT`, nunca replay.

Duas instâncias podem passar pelo passo 1 ao mesmo tempo com uma chave nova para wallets diferentes (payload divergente, por exemplo). Nesse caso a segunda bate na chave única no `INSERT`; o use case tenta uma única vez de novo, e a releitura vira replay ou conflito.

A API e a fila compartilham o mesmo espaço de idempotência: a mesma operação por HTTP e depois por SQS é replay.

## Regras de negócio e interpretações

| Operação | Saldo | Referência |
|---|---|---|
| BET | débito; rejeita sem saldo (`INSUFFICIENT_FUNDS`) | não usa |
| WIN | crédito | opcional; se vier, precisa ser uma BET que não foi revertida; o valor pode ser diferente |
| LOSS | nenhum; valor pode ser 0 | não usa |
| REFUND | crédito | obrigatória; só BET; valor igual ao da BET |
| ROLLBACK | inverso da referência | obrigatória; BET, WIN ou REFUND; valor igual |

A referência é procurada por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo provedor, jogador, wallet, moeda e rodada, e estar `PROCESSED`.

Algumas interpretações:

- O desafio diz que uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação. Fui mais restrito: uma referência só pode ser revertida uma vez, por qualquer tipo. Com a regra literal, um REFUND e depois um ROLLBACK da mesma BET devolveriam o valor duas vezes. O ROLLBACK de um REFUND continua permitido, porque a referência dele é o REFUND, não a BET.
- Reversão que deixaria o saldo negativo (ROLLBACK de um WIN já gasto) é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`, diferente do `INSUFFICIENT_FUNDS` de uma aposta.
- Transação para uma wallet que existe, mas de outro jogador, é gravada como REJECTED com `PLAYER_WALLET_MISMATCH`, para ficar auditável. Para uma wallet que não existe não há o que gravar (a FK exige a wallet), e a resposta é 404.
- Moeda diferente da wallet é gravada como REJECTED com `CURRENCY_MISMATCH`.
- Um WIN que referencia uma BET já devolvida (por REFUND ou ROLLBACK) é rejeitado com `REFERENCE_ALREADY_REVERSED`: não existe prêmio de uma aposta que foi desfeita. Vários WINs da mesma BET continuam valendo, porque uma rodada pode ter mais de um prêmio (giros grátis, por exemplo).

## Códigos de falha

| `failureCode` | Quando | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desiste ou aposta menos |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria o saldo negativo | trata manualmente |
| `BALANCE_LIMIT_EXCEEDED` | crédito passaria do maior saldo armazenável | trata manualmente |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrige o payload |
| `PLAYER_WALLET_MISMATCH` | wallet de outro jogador | corrige o payload |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro do prazo de espera | confere o id ou reenvia a referência |
| `REFERENCE_NOT_PROCESSED` | a referência existe mas foi rejeitada, falhou ou não terminou no prazo | não reenvia igual |
| `REFERENCE_MISMATCH` | referência de outro jogador, wallet, rodada ou moeda | corrige o payload |
| `REFERENCE_INVALID_KIND` | tipo de referência não permitido (REFUND de um WIN, por exemplo) | corrige o payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor do REFUND ou ROLLBACK diferente do da referência | corrige o payload |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida (inclui WIN de uma BET devolvida) | nada a fazer |
| `PROCESSING_FAILED` | `FAILED`: o worker desistiu depois de erros não transitórios | abre chamado; o erro está em `last_error` |

Os erros de requisição (sem transação gravada) têm os próprios códigos no corpo: `INVALID_PAYLOAD` (JSON mal formado), `PAYLOAD_TOO_LARGE` (body acima de 100 KB), `INVALID_REQUEST`, `INVALID_MONEY`, `INVALID_TRANSACTION`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `WALLET_ALREADY_EXISTS` (com o `walletId` existente), `IDEMPOTENCY_CONFLICT`, `SERVICE_UNAVAILABLE` e `INTERNAL_ERROR`. Rota inexistente responde `HTTP_404`.

## Status HTTP

A tabela está no README. O critério foi que o provedor decida pelo status, sem ler mensagem: 201/200 seguiu, 202 espere, 4xx não reenvie igual, 503 reenvie com a mesma chave. Os dois estados terminais de falha (REJECTED e FAILED) saem como 422 e se diferenciam pelo `status` e pelo `failureCode` do corpo. FAILED não é 500 porque 5xx diz "tente de novo", e cada nova tentativa seria um replay com o mesmo resultado.

Erro de infraestrutura (lock que não veio, pool cheio, banco fora, conexão derrubada no meio da transação) é 503 com `Retry-After`. O 202 de uma pendente traz `Retry-After` e `nextReferenceCheckAt` calculados no relógio do banco.

## Referências fora de ordem

REFUND, ROLLBACK ou WIN cuja referência ainda não existe (ou ainda não está em estado final) é gravada como `PENDING_REFERENCE`, com `attempts` e `next_attempt_at`. Um `CHECK` garante que toda pendente tem data, para nenhuma ficar esquecida.

O worker roda em todas as instâncias. Ele aluga pendentes devidas com `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, empurrando `next_attempt_at` 30s para frente. Os outros workers deixam de ver essas linhas, e se o worker morrer o aluguel vence e outro assume. Cada pendente é resolvida na própria transação, travando a wallet primeiro, como no use case. Se o status ou o número de tentativas mudou desde o aluguel, ela é pulada.

A espera é exponencial: 2s, 4s, 8s e assim por diante, até 120s, em 8 tentativas, cerca de 4 minutos no total. Fora de ordem normalmente é questão de milissegundos ou segundos; 4 minutos cobrem atrasos de fila e retries do provedor sem deixar uma devolução de dinheiro pendurada por horas. Esgotado o limite, a pendente vira REJECTED com `REFERENCE_NOT_FOUND` (nunca chegou) ou `REFERENCE_NOT_PROCESSED` (chegou mas não terminou PROCESSED), e o evento `WagerTransactionRejected` é publicado.

Quando uma transação chega a estado final, as pendentes que apontam para ela ficam devidas na hora, sem esperar o agendamento. Isso funciona em cadeia: resolver um REFUND acorda o ROLLBACK que aponta para ele.

## Consumidor SQS

O consumidor tem N leitores em paralelo (`SQS_CONSUMER_CONCURRENCY`, padrão 5), cada um lendo uma mensagem por vez. A ordem por wallet vem da própria FIFO: enquanto uma mensagem de um MessageGroup está em processamento, as próximas do mesmo grupo não são entregues, e grupos diferentes seguem em paralelo. A primeira versão lia em lote, e no LocalStack as mensagens que só esperavam a vez gastavam entregas (o `ApproximateReceiveCount` subia sem processamento). Com uma mensagem por leitor isso não acontece, e o teste "mensagem que só esperou a vez não gasta entregas" em `sqs-consumer.test.ts` prova que ela chega à primeira tentativa com contador 1.

Para cada mensagem:

1. se o `messageId` já está na inbox com o mesmo conteúdo, é reentrega de algo confirmado: só dá ack. Com conteúdo diferente, vai para a DLQ com `MESSAGE_ID_CONFLICT`, porque descartar em silêncio perderia uma operação;
2. senão, chama o use case, e a inbox (`PRIMARY KEY (consumer_name, message_id)`) é gravada dentro da mesma transação da operação;
3. o ack (`DeleteMessage`) só acontece depois do commit. Se o processo morrer entre o commit e o ack, a reentrega cai no passo 1.

Os erros seguem a mesma classificação da API:

| Tipo | Exemplos | Destino |
|---|---|---|
| resultado de negócio | REJECTED, PENDING_REFERENCE | ack, porque a operação foi registrada |
| permanente | envelope inválido, payload inválido, wallet inexistente, conflito de idempotência | DLQ na hora, com `errorCode` e `errorReason` como atributos |
| transitório | banco fora, lock, pool, SQS | retry com backoff pela visibilidade da mensagem |

O retry muda a visibilidade da mensagem para 2s, 4s, 8s, 16s, 32s, 60s e 60s: são 8 tentativas, cerca de 3 minutos, o suficiente para um failover de banco. Esgotadas, vai para a DLQ com `RETRIES_EXHAUSTED`. A fila tem `maxReceiveCount` 10, acima das 8 da aplicação: é uma rede de segurança para o caso de o processo morrer em toda tentativa antes de decidir. Quem manda para a DLQ, com o motivo, é a aplicação.

Em `SIGTERM` o consumidor para de ler, termina a mensagem em andamento e devolve com visibilidade 0 as que chegarem durante a parada. O `stop_grace_period` do Compose é 30s, mais que a leitura longa (10s) e o processamento de uma mensagem.

## Outbox e eventos

Os eventos são gravados na tabela `outbox_messages` dentro da mesma transação da operação. Se a transação não confirma, o evento não existe. Nada é publicado antes do commit.

O relay roda em todas as instâncias. A unidade dele é a wallet, a mesma do resto do sistema:

- só entra na rodada a wallet cujo evento pendente mais antigo está devido, então um evento em backoff segura os seguintes da mesma wallet;
- `pg_try_advisory_xact_lock` por wallet garante um relay por wallet de cada vez. Se outro relay já está com ela, este pula para a próxima em vez de esperar. O lock é solto no commit, no rollback ou se a conexão cair.

Com isso, os eventos de cada wallet chegam à fila na ordem em que aconteceram. A FIFO de eventos usa `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`.

O relay publica um evento por vez e marca cada um como publicado. Se uma publicação falha, aquele evento ganha backoff (1s até 60s) e o lote para ali, porque o SQS provavelmente está fora e insistir no resto só manteria a transação aberta. O resto não gasta tentativa. O lote também tem prazo, de 2s: com o SQS lento, o relay confirma o que já saiu, deixa o resto pendente na mesma ordem e emenda a próxima rodada na hora. O prazo é conferido entre uma publicação e outra, então não é um limite rígido da transação inteira. Com o banco respondendo normalmente (milissegundos), a transação dura no máximo cerca de 7s: o prazo mais uma publicação, que tem timeout de 5s. Com o banco lento, cada consulta do lote ainda pode levar até o `statement_timeout` (15s), e o pior caso cresce na mesma medida. Em todo caso há limite, e o desligamento normal cabe nos 30s do Compose. Não há limite de tentativas: o evento é de uma operação já confirmada e não pode ser descartado. O alarme é a métrica `outbox_oldest_pending_age_seconds`.

A entrega é at-least-once. Se o processo morrer depois de publicar e antes do commit, o evento volta e sai de novo com o mesmo `eventId`, e o consumidor deduplica por ele. Os testes cobrem os dois lados: commit feito e processo morto antes de publicar (outra instância publica), e processo morto depois de publicar (o evento sai duas vezes com o mesmo id).

Eventos:

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | rejeitada, inclusive quando a referência não chegou no prazo |
| `WagerTransactionPendingReference` | ficou esperando a referência |
| `WalletBalanceChanged` | só quando o saldo muda, com `balanceBefore`, `balanceAfter` e `walletVersion` |
| `WagerTransactionFailed` | o worker desistiu da pendente (além do mínimo pedido) |

O envelope é uma classe abstrata (`IntegrationEvent`) com uma subclasse por evento; `eventType` e `version` ficam no tipo. O `aggregateId` é a `walletId`. O `correlationId` segue o da requisição original, inclusive nos eventos que o worker publica minutos depois. O `causationId` é o `messageId` quando a operação veio da fila. O `data` só tem `MoneyProps` (string decimal), nunca a instância de `Money`.

## Relógio

Todas as datas gravadas vêm do relógio do banco (`clock_timestamp()`): criação, processamento, agendamento de pendentes, backoff da outbox e o `Retry-After`. Com três instâncias, cada uma com o próprio relógio, comparar datas geradas em máquinas diferentes daria resultado errado. Uma app adiantada atrasaria a publicação de eventos pelo tamanho da diferença. O teste `clock-skew.test.ts` desloca o relógio da aplicação 1 hora para frente e para trás (`setSystemTime`) e confere que o agendamento das pendentes, o backoff da outbox e os eventos de abertura de wallet continuam no tempo certo. A exceção é o campo `time` dos logs, que usa o relógio da máquina.

## Observabilidade

Logs em JSON, uma linha por evento, todos com o contexto da operação: `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. O contexto vem de um `AsyncLocalStorage` aberto pelo middleware HTTP, pelo consumidor e pelo worker. O `X-Correlation-Id` do provedor é aceito se for curto e seguro (`[A-Za-z0-9._:-]{1,128}`); senão a requisição ganha um id novo, e ela segue de qualquer jeito. Na fila vale a mesma regra para o `correlationId` do envelope: inválido, o rastreio usa o `messageId` e a aposta é processada. O id volta no header da resposta e é gravado na transação.

O logger descarta chaves com payload ou valor financeiro (`payload`, `body`, `data`, `money`, `amount`, `balance`, `difference` e parecidas). Erros do driver do banco saem só com o tipo e o código SQL, porque a mensagem deles traz o SQL com os valores. Os logs do MikroORM e do knex passam pelo mesmo logger, inclusive no container `migrate`.

Toda requisição HTTP gera uma linha de acesso, exceto `/health/*` e `/metrics` quando respondem com sucesso: o healthcheck do Docker chama a readiness a cada 3s em cada réplica, e essas linhas eram 99% do log de um stack parado. Com erro, elas continuam saindo, porque aí são sinal.

Métricas em `GET /metrics` (Prometheus):

| Métrica | Cobre |
|---|---|
| `wagering_transactions_total{channel,kind,status}` | transações por status |
| `wagering_duplicates_total{type}` | replay de idempotência, reentrega reconhecida pela inbox, `messageId` reaproveitado |
| `wagering_retries_total{component}` | retries do consumidor, da outbox, do worker e da corrida de idempotência |
| `sqs_dead_lettered_total{reason}` e `sqs_dlq_messages` | mensagens mandadas para a DLQ e o tamanho atual dela |
| `wallet_lock_conflicts_total{type}` e `wallet_lock_wait_seconds` | `lock_timeout`, deadlock, serialização, versão desatualizada e o tempo de espera pelo lock |
| `outbox_oldest_pending_age_seconds`, `outbox_pending_messages`, `outbox_publish_delay_seconds` | outbox lag |
| `wagering_processing_duration_seconds{channel,outcome}` | latência de processamento |
| `wagering_pending_references`, `wallet_reconciliation_divergences_total` | pendentes e divergências de reconciliação |

As contagens de transações, retries e atrasos de publicação só são incrementadas depois do commit, para nunca contarem algo que foi desfeito.

`/health/live` não consulta nada: só diz que o processo responde. `/health/ready` consulta o Postgres e as filas dos componentes ligados, cada um com timeout, e responde 503 se algum estiver fora. O healthcheck do Compose usa a readiness, e o gateway só sobe depois que as réplicas ficam saudáveis.

A reconciliação (`POST /wallets/:id/reconciliation`) compara o saldo gravado com a soma do ledger numa única consulta, então lê os dois da mesma foto do banco. Ela também confere o encadeamento: cada lançamento precisa começar onde o anterior terminou, o que pega erros que a soma sozinha não pega. Divergência é logada, contada em métrica e sinalizada na resposta, nunca corrigida.

## Autenticação

Não implementei. O desafio não pontua autenticação e pede que ela não compita com o núcleo financeiro.

O ponto de extensão está no código: `ProviderAuthGuard`, aplicado aos controllers de wallets e de transações, hoje deixa tudo passar. O desenho que eu adotaria é Keycloak, com cada provedor sendo um client OIDC com client credentials. O guard validaria o JWT pela JWKS do Keycloak e conferiria que o client do token é o `providerId` do payload, para um provedor não submeter em nome de outro. Os endpoints de health ficam abertos, como pede o desafio. As mensagens da fila são tratadas como canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## Testes

Os testes de integração usam o Postgres e o LocalStack reais, sem mock de banco nem de fila. Os testes de concorrência disparam operações de verdade em paralelo, e os de várias instâncias sobem a app em três processos filhos sobre o mesmo banco. O teste de restart mata um dos três com `kill -9` no meio da carga e confere que cada wallet termina com o saldo exato esperado.

Todo arquivo de integração termina conferindo, em todas as wallets do banco, que o saldo gravado é igual ao reconstruído pelo ledger, como pede a seção 13.

Vários testes nasceram de um bug encontrado em revisão, e o histórico de commits mostra cada correção junto com o teste que a reproduz (`git log --grep fix:`). Cada um foi escrito antes da correção e visto falhando pelo motivo certo. Alguns testes que passavam foram conferidos com mutação (quebrar o código de propósito e ver o teste falhar), porque já houve casos de teste verde que não provava o que dizia provar.

## Limitações e o que eu faria com mais tempo

Sobre robustez em produção:

- Uma instância congelada segurando o lock de uma wallet ainda trava aquela wallet por até 30s, até o `idle_in_transaction_session_timeout` encerrar a sessão. Nesse intervalo, as operações naquela wallet recebem 503 depois de 5s. Um limite menor encurtaria a janela, mas precisa ficar acima do pior caso do relay (cerca de 7s), com folga para um SQS lento.
- O relay mantém a transação e os locks abertos enquanto chama o SQS. É o que dá a garantia simples de um relay por wallet, em ordem. O custo está limitado: uma falha encerra o lote na hora, e o prazo de 2s corta publicações lentas, então a transação dura no máximo cerca de 7s com o banco respondendo normalmente. O prazo é conferido entre publicações, não é um teto rígido: com o banco lento, cada consulta do lote pode levar até o `statement_timeout`. A solução sem esse custo seria alugar os eventos por wallet e publicar fora da transação, com o aluguel fazendo o papel do lock.
- A perda de conexão no meio de uma consulta é reconhecida pela mensagem do driver `pg`, porque ele não põe código no erro. Se a mensagem mudar numa versão futura do driver, esse caso volta a ser tratado como erro inesperado (500 na API).
- A inbox e a outbox crescem para sempre. Faltam jobs de limpeza: eventos publicados há mais de alguns dias e mensagens da inbox mais antigas que a janela de reentrega.
- Depois de uma queda do banco ou do SQS, os loops em segundo plano levam até 10s para perceber que voltou (teto da espera entre rodadas que falham).

Sobre filas e ordem:

- A ordem dos eventos por wallet tem um custo: um evento em backoff segura os seguintes da mesma wallet até sair, como a própria FIFO faz dentro de um MessageGroup.
- Uma mensagem de entrada em retry segura o MessageGroup dela por até cerca de 3 minutos. Se o provedor usar um grupo só para tudo, uma mensagem com problema atrasa todas.
- O `maxReceiveCount` 10 também conta as entregas devolvidas em shutdown. Muitos restarts seguidos com a mesma mensagem em voo poderiam mandá-la para a DLQ pela política da fila, sem o motivo que a aplicação grava.
- O relay ordena os eventos de uma wallet por `(occurred_at, id)`. O `occurred_at` passa por um `Date` do JavaScript, que guarda milissegundos, e o desempate pelo `id` (UUIDv7) só é garantido dentro de um mesmo processo. Duas transações da mesma wallet, em réplicas diferentes e no mesmo milissegundo, poderiam sair na ordem trocada. Na prática isso não se reproduziu: sob carga com três processos, o menor intervalo medido entre transações seguidas da mesma wallet foi de 9 ms, porque cada uma faz vários round-trips ao banco depois de ler a hora. A correção seria ordenar por uma sequência do banco atribuída no `INSERT`, já que o lock da wallet serializa as inserções.
- O comportamento da FIFO (ordem por grupo, visibilidade, redrive) foi verificado no LocalStack, não na AWS.

Sobre regras de negócio:

- O caso inverso do WIN sobre aposta devolvida continua aceito: um REFUND ou ROLLBACK de uma BET que já teve WIN devolve a aposta e o prêmio fica. O desafio não define o que fazer nesse caso; num sistema real eu confirmaria a regra com o time de produto (provavelmente exigindo o ROLLBACK do WIN antes).
- A entrada de `Money` aceita valores com 0 ou 1 casa decimal, normalizados para 2 (ver a seção Money).
- O ledger é de entrada simples por wallet. Partidas dobradas eram diferencial opcional e ficaram de fora.

Sobre segurança:

- Não há autenticação. `/metrics`, a reconciliação e as consultas estão abertas, e o `providerId` do payload não é verificado contra uma identidade.

Sobre os testes:

- O `kill -9` do teste de restart cai em momentos aleatórios da carga; ele não mira exatamente o instante entre o commit e a resposta HTTP. Esse instante é coberto pelo replay idempotente (o cliente reenvia e recebe o resultado original) e, na fila, por um teste em que um processo filho consome a mensagem e se mata com `SIGKILL` no instante do ack, depois do commit.
- O `SIGTERM` real é testado em `sigterm.test.ts`: o teste sobe a app num processo, manda o sinal e confere que o consumidor, o relay e o worker registram a parada e que o processo termina sozinho. No Windows não dá para mandar `SIGTERM` de um processo para outro, então lá o teste é pulado; ele roda na CI, em Linux. O teste não coloca uma mensagem em processamento no momento do sinal; esse caso é coberto pelo teste do `stop()` do consumidor.
- Não fiz teste de carga (`bun run test:load` era diferencial opcional).
