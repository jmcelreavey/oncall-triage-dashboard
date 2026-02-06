import { promises as fs } from 'fs';
import path from 'path';

const root = path.resolve(process.cwd());

async function parseEnvExample(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) {
      entries.push({ raw: line, key: null });
      continue;
    }
    const idx = line.indexOf('=');
    if (idx === -1) {
      entries.push({ raw: line, key: null });
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    entries.push({ key, value, raw: line });
  }
  return entries;
}

function formatValue(value) {
  if (value === undefined || value === null) return '';
  const needsQuotes = /\s|#/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function writeEnvFile(outPath, entries, overrides) {
  const lines = entries.map((entry) => {
    if (!entry.key) return entry.raw;
    const value = overrides[entry.key] ?? entry.value ?? '';
    return `${entry.key}=${formatValue(value)}`;
  });
  await fs.writeFile(outPath, lines.join('\n'));
}

async function main() {
  const env = process.env;
  const rootExample = path.join(root, '.env.example');
  const apiExample = path.join(root, 'apps/api/.env.example');
  const webEnvPath = path.join(root, 'apps/web/.env.local');
  const rootEnvPath = path.join(root, '.env');
  const apiEnvPath = path.join(root, 'apps/api/.env');

  const rootEntries = await parseEnvExample(rootExample);
  const rootOverrides = {};
  for (const entry of rootEntries) {
    if (!entry.key) continue;
    if (env[entry.key] !== undefined) rootOverrides[entry.key] = env[entry.key];
  }

  await writeEnvFile(rootEnvPath, rootEntries, rootOverrides);

  const apiEntries = await parseEnvExample(apiExample);
  const apiOverrides = {};
  for (const entry of apiEntries) {
    if (!entry.key) continue;
    if (env[entry.key] !== undefined) apiOverrides[entry.key] = env[entry.key];
  }
  await writeEnvFile(apiEnvPath, apiEntries, apiOverrides);

  const apiUrl = env.NEXT_PUBLIC_API_URL || rootOverrides.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  const openCodeUrl =
    env.NEXT_PUBLIC_OPENCODE_WEB_URL ||
    env.OPENCODE_WEB_URL ||
    rootOverrides.OPENCODE_WEB_URL ||
    'http://127.0.0.1:4096';
  await fs.writeFile(
    webEnvPath,
    `NEXT_PUBLIC_API_URL=${apiUrl}\nNEXT_PUBLIC_OPENCODE_WEB_URL=${openCodeUrl}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
