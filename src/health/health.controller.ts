import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { ReadinessChecker, type ReadinessReport } from "./readiness";

/** Abertos, sem autenticação (seção 9 do desafio). */
@Controller("health")
export class HealthController {
  constructor(@Inject(ReadinessChecker) private readonly readiness: ReadinessChecker) {}

  // Liveness: só responde se o processo está de pé.
  // Não consulta banco nem fila, senão uma queda do Postgres
  // faria o orquestrador reiniciar instâncias saudáveis à toa.
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  // Readiness: Postgres e as filas dos componentes ligados.
  // 503 tira a instância do balanceamento até as dependências voltarem.
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === "ok" ? 200 : 503);
    return report;
  }
}
