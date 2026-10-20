import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { JsonLogger } from "./infrastructure/observability/json-logger";

async function bootstrap(): Promise<void> {
  // bufferLogs: os logs da inicialização esperam o JsonLogger e também saem em JSON
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new JsonLogger());

  // Em SIGTERM o Nest chama os hooks de shutdown dos módulos,
  // que é onde o consumidor SQS vai terminar o que está em andamento.
  app.enableShutdownHooks();

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
