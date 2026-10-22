/**
 * Processo filho de um teste: consome UMA mensagem com o consumidor real e
 * morre com SIGKILL no instante do ack, depois do commit. É o cenário da
 * seção 13 "worker morto depois do commit e antes do ack", com morte de
 * verdade: o processo some, a conexão com o banco cai, nada é finalizado.
 *
 * Uso: bun run test/integration/support/die-at-ack.ts <queueUrl> <dlqUrl>
 * Sai com código 3 se o ack nunca for chamado (o teste trata como falha).
 */
import { DeleteMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransactionUseCase } from "../../../src/application/wagering/process-wager-transaction.use-case";
import { createOrmConfig } from "../../../src/infrastructure/database/mikro-orm.config";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs";
import { SqsWagerConsumer } from "../../../src/infrastructure/messaging/sqs-wager-consumer";
import { wageringPorts } from "../../../src/infrastructure/wiring";

const [queueUrl, dlqUrl] = process.argv.slice(2);
if (!queueUrl || !dlqUrl) throw new Error("usage: die-at-ack.ts <queueUrl> <dlqUrl>");

// ORM direto, sem createTestOrm: aquele recria o schema e apagaria os dados do teste
const orm = await MikroORM.init(createOrmConfig(process.env.DATABASE_TEST_URL));
const real = createSqsClient();
const dieOnAck = {
  send: (cmd: unknown, opts?: unknown) => {
    if (cmd instanceof DeleteMessageCommand) process.kill(process.pid, "SIGKILL");
    return real.send(cmd as never, opts as never);
  },
} as unknown as SQSClient;

const consumer = new SqsWagerConsumer(dieOnAck, orm, new ProcessWagerTransactionUseCase(orm, wageringPorts()), {
  queueUrl,
  dlqUrl,
  consumerName: "wager-transactions-consumer",
  waitTimeSeconds: 5,
  maxAttempts: 3,
  backoffBaseSeconds: 0,
  backoffMaxSeconds: 0,
});
await consumer.pollOnce();
process.exit(3); // chegou aqui: o ack não foi chamado
