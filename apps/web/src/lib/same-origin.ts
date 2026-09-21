import { resolveAuthOriginConfig } from './auth-origin';

export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && origin === resolveAuthOriginConfig(process.env).baseURL;
  } catch { return false; }
}
