import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

const candidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../.env'),
  resolve(__dirname, '../.env'),
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../.env'),
  resolve(__dirname, '../../../../.env'),
  resolve(__dirname, '../../../../../.env'),
];

for (const candidate of candidates) {
  if (existsSync(candidate)) {
    console.log(`[config] Loading environment from: ${candidate}`);
    config({ path: candidate, override: false });
  }
}
