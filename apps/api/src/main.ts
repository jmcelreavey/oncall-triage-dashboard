import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({ origin: webOrigin });
  await app.listen(port);
  console.log(`[API] Listening on port ${port}`);

  const shutdown = async (signal: string) => {
    console.log(`[API] ${signal} received, starting shutdown...`);
    if (process.stdout) process.stdout.write('');
    await app.close();
    console.log('[API] Shutdown complete.');
    if (process.stdout) process.stdout.write('');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
void bootstrap();
