import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error: string;
  path: string;
  timestamp: string;
  details?: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawResponse = isHttpException ? exception.getResponse() : undefined;
    const message = isHttpException
      ? this.extractMessage(exception, rawResponse)
      : 'Internal server error';

    const body: ErrorResponseBody = {
      statusCode: status,
      message,
      error: HttpStatus[status] ?? 'Error',
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    const details = this.extractDetails(rawResponse);
    if (details !== undefined) body.details = details;

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed with ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${status}: ${message}`,
      );
    }

    response.status(status).json(body);
  }

  private extractMessage(
    exception: HttpException,
    rawResponse: unknown,
  ): string {
    if (typeof rawResponse === 'string') return rawResponse;

    if (
      rawResponse &&
      typeof rawResponse === 'object' &&
      'message' in rawResponse
    ) {
      const { message } = rawResponse as { message: string | string[] };
      return Array.isArray(message) ? message.join(', ') : message;
    }

    return exception.message;
  }

  private extractDetails(rawResponse: unknown): unknown {
    if (
      !rawResponse ||
      typeof rawResponse !== 'object' ||
      !('message' in rawResponse)
    ) {
      return undefined;
    }

    const rest: Record<string, unknown> = { ...rawResponse };
    delete rest.message;

    return Object.keys(rest).length > 0 ? rest : undefined;
  }
}
