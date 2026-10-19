import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Em SIGTERM o Nest chama os hooks de shutdown dos módulos,
  // que é onde o consumidor SQS vai terminar o que está em andamento.
  app.enableShutdownHooks();

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
