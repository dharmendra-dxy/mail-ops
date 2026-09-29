import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { API_KEY_HEADER } from './common/guards/api-key.guard';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const configService = app.get(ConfigService);

  app.setGlobalPrefix(configService.get<string>('app.apiPrefix', 'api'));
  app.enableCors({ origin: true });
  // Required for `OnApplicationShutdown`: without it a SIGTERM closes the
  // process before the in-flight campaign row can settle.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = configService.get<number>('app.port', 3000);
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `MailOps listening on port ${port} (env: ${configService.get<string>('app.env')})`,
  );

  const apiKeyEnabled = configService.get<boolean>('security.enabled', false);
  logger.log(
    apiKeyEnabled
      ? `API key required on every endpoint except GET /api/health — send it as "${API_KEY_HEADER}: <key>"`
      : 'No API key configured — the API is open. Set API_KEY before exposing this port.',
  );
}

void bootstrap();
