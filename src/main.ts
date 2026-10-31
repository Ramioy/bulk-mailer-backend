import { createApp } from './bootstrap';
import { loadConfig } from './config/app-config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
}

void main();
