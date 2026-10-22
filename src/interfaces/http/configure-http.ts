import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { CorrelationMiddleware } from "./correlation.middleware";

/**
 * Prepara a app HTTP. Chamado ANTES do listen(), tanto no main.ts quanto nos
 * testes, para os dois se comportarem igual.
 *
 * A correlação é registrada direto no Express, e não como middleware de
 * módulo do Nest: o Nest registra o parser de JSON no init(), antes dos
 * middlewares de módulo. Com JSON mal formado, o parser respondia 400 antes
 * de a correlação rodar, e a resposta saía sem X-Correlation-Id, sem
 * X-Instance e sem linha de acesso. Um app.use() feito antes do listen()
 * fica à frente do parser.
 */
export function configureHttp(app: INestApplication): void {
  const correlation = new CorrelationMiddleware();
  app.use((request: Request, response: Response, next: NextFunction) => correlation.use(request, response, next));
}
