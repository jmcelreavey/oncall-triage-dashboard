import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load from project root .env only (single source of truth)
let rootEnv = resolve(process.cwd(), '../../.env');

if (!existsSync(rootEnv)) {
  rootEnv = resolve(process.cwd(), '.env');
}

if (existsSync(rootEnv)) {
  console.log(`[config] Loading environment from: ${rootEnv}`);
  config({ path: rootEnv });
} else {
  console.warn(`[config] No .env file found`);
}
