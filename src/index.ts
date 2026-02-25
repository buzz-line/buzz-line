import { startServer } from './server';

startServer().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[Server] Failed to start:', message);
  process.exit(1);
});
