import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
// import { prisma } from './db';
// import { queues } from './queues/connection';

const start = async () => {
  try {
    const app = createApp();

    const server = app.listen(env.PORT, () => {
      logger.info(`Server listening on port ${env.PORT}`);
    });

    const shutdown = async () => {
      logger.info('Shutting down...');
      server.close();
      // await prisma.$disconnect();
      // await queues.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
};

start();
