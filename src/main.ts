import 'reflect-metadata';
import type { AppConfig } from '@/config/app-config';
import { ConfigValidationError, loadConfig } from '@/config/load-config';
import { createApp } from '@/create-app';

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) {
      // O logger ainda não existe: emite a falha no mesmo formato JSON dos logs.
      console.error(JSON.stringify({ level: 'fatal', msg: 'Invalid configuration', issues: error.issues }));
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
