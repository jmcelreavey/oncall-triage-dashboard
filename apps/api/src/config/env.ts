export function env(key: string, fallback?: string) {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value;
}

export function envNumber(key: string, fallback: number) {
  const value = env(key);
  if (!value) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function envBool(key: string, fallback: boolean) {
  const value = env(key);
  if (!value) return fallback;
  return value.toLowerCase() === 'true';
}
