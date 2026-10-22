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

    // erros do próprio Nest (JSON mal formado, rota inexistente...)
    if (error instanceof HttpException) {
      const status = error.getStatus();
      response.status(status).json({ code: httpCode(status), message: error.message });
      return;
    }
    // Erros do parser do Express (body grande demais, charset não suportado)
    // não são HttpException, mas trazem o status 4xx certo e a marca de que
    // podem ir para o cliente. Sem isto viravam 500, e 5xx diz "tente de novo".
    const parserStatus = clientErrorStatus(error);
    if (parserStatus !== undefined) {
      response.status(parserStatus).json({ code: httpCode(parserStatus), message: (error as Error).message });
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

function httpCode(status: number): string {
  if (status === HttpStatus.BAD_REQUEST) return "INVALID_PAYLOAD";
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) return "PAYLOAD_TOO_LARGE";
  return `HTTP_${status}`;
}

/** Status de um erro 4xx do body-parser (http-errors: `status` + `expose`), ou undefined. */
function clientErrorStatus(error: unknown): number | undefined {
  const e = error as { status?: unknown; expose?: unknown } | null;
  const status = e?.status;
  return typeof status === "number" && status >= 400 && status < 500 && e?.expose === true ? status : undefined;
}
