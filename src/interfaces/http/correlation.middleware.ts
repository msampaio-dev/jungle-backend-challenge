import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { hostname } from "node:os";
import { runWithContext } from "../../application/shared/operation-context";

/** Só o que é seguro de repetir em logs e headers; o resto é trocado por um id novo. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const CORRELATION_HEADER = "X-Correlation-Id";
/** máquina (no Docker, o id do container) e processo */
const INSTANCE_ID = `${hostname()}:${process.pid}`;

/**
 * Abre o contexto de log da requisição. Usa o X-Correlation-Id do provedor
 * quando é válido; senão gera um. Inválido não derruba a requisição:
 * rastreio nunca pode impedir uma aposta. O id volta no header da resposta
 * e segue para a transação gravada e os eventos.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger("Http");

  use(request: Request, response: Response, next: NextFunction): void {
    const received = request.header(CORRELATION_HEADER);
    const correlationId = received && VALID_CORRELATION_ID.test(received) ? received : Bun.randomUUIDv7();
    response.setHeader(CORRELATION_HEADER, correlationId);
    // com várias réplicas atrás do gateway, diz qual delas atendeu
    response.setHeader("X-Instance", INSTANCE_ID);

    const startedAt = performance.now();
    response.on("finish", () => {
      // o "finish" roda fora do contexto da requisição: reabre com o mesmo id
      runWithContext({ correlationId }, () =>
        this.logger.log({
          msg: "http request",
          method: request.method,
          path: request.originalUrl.split("?")[0],
          status: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        }),
      );
    });

    runWithContext({ correlationId }, next);
  }
}
