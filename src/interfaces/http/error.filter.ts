import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { classifyError, ErrorKind, errorCode } from "../../application/error-kind";
import { ApplicationError } from "../../application/errors";
import { describeError } from "../../application/shared/describe-error";

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  [ErrorKind.InvalidInput]: HttpStatus.BAD_REQUEST,
  [ErrorKind.NotFound]: HttpStatus.NOT_FOUND,
  [ErrorKind.Conflict]: HttpStatus.CONFLICT,
  [ErrorKind.Transient]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorKind.Unexpected]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Toda resposta de erro sai como { code, message } com status consistente. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // erros do próprio Nest/Express (JSON mal formado, rota inexistente...)
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const code = status === HttpStatus.BAD_REQUEST ? "INVALID_PAYLOAD" : `HTTP_${status}`;
      response.status(status).json({ code, message: error.message });
      return;
    }

    const kind = classifyError(error);
    const status = STATUS_BY_KIND[kind];

    if (kind === ErrorKind.Transient) {
      response.setHeader("Retry-After", "1");
    }
    if (kind === ErrorKind.Unexpected || kind === ErrorKind.Transient) {
      this.logger.error({ msg: "request failed", kind, error: describeError(error) });
    }

    // mensagem interna não vaza em erro inesperado nem de infraestrutura
    const message =
      kind === ErrorKind.Unexpected
        ? "unexpected error"
        : kind === ErrorKind.Transient
          ? "service temporarily unavailable, retry with the same Idempotency-Key"
          : ((error as Error)?.message ?? "error");
    const details = error instanceof ApplicationError ? error.details : {};
    response.status(status).json({ code: errorCode(error), message, ...details });
  }
}
