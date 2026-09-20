export type AuthOriginEnvironment = {
  AICHAT_LOCAL_SMOKE?: string;
  BETTER_AUTH_URL?: string;
  NODE_ENV?: string;
};

export type AuthOriginConfig = {
  baseURL: string;
  trustedOrigins: string[];
};

const LOCAL_TRUSTED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3100',
  'http://127.0.0.1:3100',
] as const;

function parseHttpOrigin(value: string): URL {
  try {
    const rawOrigin = /^(https?):\/\/([^/?#]+)\/?$/i.exec(value);
    const authority = rawOrigin?.[2];
    if (
      value !== value.trim()
      || /[\u0000-\u001f\u007f]/.test(value)
      || !rawOrigin
      || authority?.includes('@')
      || authority?.includes('\\')
    ) {
      throw new Error('invalid origin');
    }
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error('invalid origin');
    }
    return url;
  } catch {
    throw new Error('BETTER_AUTH_URL must be a valid HTTP(S) origin');
  }
}

export function resolveAuthOriginConfig(
  env: AuthOriginEnvironment,
): AuthOriginConfig {
  let baseURL: string;
  const isLocalSmoke = env.AICHAT_LOCAL_SMOKE === '1';

  if (env.BETTER_AUTH_URL) {
    const url = parseHttpOrigin(env.BETTER_AUTH_URL);
    const isLoopback = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]';
    if (isLocalSmoke && !isLoopback) {
      throw new Error('BETTER_AUTH_URL must use a loopback origin in local smoke mode');
    }
    if (url.protocol === 'http:') {
      if (env.NODE_ENV === 'production' && !isLocalSmoke) {
        throw new Error('BETTER_AUTH_URL must use HTTPS in production');
      }
      if (!isLocalSmoke || !isLoopback) {
        throw new Error(
          'HTTP BETTER_AUTH_URL is allowed only for local smoke loopback origins',
        );
      }
    }
    baseURL = url.origin;
  } else if (isLocalSmoke) {
    baseURL = 'http://127.0.0.1:3100';
  } else if (env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_URL is required in production');
  } else {
    baseURL = 'http://localhost:3000';
  }

  return {
    baseURL,
    trustedOrigins: env.NODE_ENV === 'production' && !isLocalSmoke
      ? [baseURL]
      : [...new Set([...LOCAL_TRUSTED_ORIGINS, baseURL])],
  };
}
