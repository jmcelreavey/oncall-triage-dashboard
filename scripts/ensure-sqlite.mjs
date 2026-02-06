import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const url = process.env.DATABASE_URL || 'file:./dev.db';
if (!url.startsWith('file:')) process.exit(0);

const filePath = url.replace('file:', '');
const resolved = path.resolve(process.cwd(), filePath);

if (existsSync(resolved)) process.exit(0);

const sqlite3 = spawnSync('which', ['sqlite3']);
if (sqlite3.status === 0) {
  spawnSync('sqlite3', [resolved, 'VACUUM;'], { stdio: 'ignore' });
} else {
  // Create empty file if sqlite3 is not available.
  await import('fs/promises').then((fs) => fs.writeFile(resolved, ''));
}
