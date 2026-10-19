import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  // Liveness: só responde se o processo está de pé.
  // Não consulta banco nem fila, senão uma queda do Postgres
  // faria o orquestrador reiniciar instâncias saudáveis à toa.
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  // /health/ready (Postgres + SQS) entra quando os dois estiverem ligados na app.
}
