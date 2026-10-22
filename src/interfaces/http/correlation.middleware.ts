import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { hostname } from "node:os";
import { runWithContext, safeCorrelationId } from "../../application/shared/operation-context";

export const CORRELATION_HEADER = "X-Correlation-Id";
/** máquina (no Docker, o id do container) e processo */
const INSTANCE_ID = `${hostname()}:${process.pid}`;
/** chamados por máquinas (healthcheck, Prometheus), não por provedores */
const QUIET_PATHS = /^\/(health|metrics)(\/|$)/;

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
    const correlationId = safeCorrelationId(request.header(CORRELATION_HEADER)) ?? Bun.randomUUIDv7();
    response.setHeader(CORRELATION_HEADER, correlationId);
    // com várias réplicas atrás do gateway, diz qual delas atendeu
    response.setHeader("X-Instance", INSTANCE_ID);

    const startedAt = performance.now();
    response.on("finish", () => {
      const path = request.originalUrl.split("?")[0]!;
      // Health e métricas são chamados o tempo todo (o healthcheck do Docker a
      // cada 3s por réplica): com sucesso, a linha seria só ruído enterrando o
      // resto. Com erro, continua saindo, porque aí é sinal.
      if (QUIET_PATHS.test(path) && response.statusCode < 400) return;
      // o "finish" roda fora do contexto da requisição: reabre com o mesmo id
      runWithContext({ correlationId }, () =>
        this.logger.log({
          msg: "http request",
          method: request.method,
          path,
          status: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        }),
      );
    });

    runWithContext({ correlationId }, next);
  }
}
