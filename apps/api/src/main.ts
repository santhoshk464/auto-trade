import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new ExpressAdapter());

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
  app.enableCors({ origin: corsOrigin, credentials: true });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 API server is running on http://localhost:${port}`);
  console.log(`🔌 WebSocket server is running on ws://localhost:${port}`);
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: any, promise) => {
  console.error('=== UNHANDLED REJECTION ===');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  if (reason?.stack) console.error('Stack:', reason.stack);
  // Don't exit the process, just log the error
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  // Don't exit the process, just log the error
});

process.on('exit', (code) => {
  console.error(`=== PROCESS EXITING with code ${code} ===`);
});

process.on('SIGTERM', () => {
  console.error('=== SIGTERM received ===');
});

process.on('SIGINT', () => {
  console.error('=== SIGINT received ===');
});

bootstrap();
