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

function normalizeHttpOrigin(value: string): string {
  try {
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
    return url.origin;
  } catch {
    throw new Error('BETTER_AUTH_URL must be a valid HTTP(S) origin');
  }
}

export function resolveAuthOriginConfig(
  env: AuthOriginEnvironment,
): AuthOriginConfig {
  let baseURL: string;

  if (env.BETTER_AUTH_URL) {
    baseURL = normalizeHttpOrigin(env.BETTER_AUTH_URL);
  } else if (env.AICHAT_LOCAL_SMOKE === '1') {
    baseURL = 'http://127.0.0.1:3100';
  } else if (env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_URL is required in production');
  } else {
    baseURL = 'http://localhost:3000';
  }

  return {
    baseURL,
    trustedOrigins: [...new Set([...LOCAL_TRUSTED_ORIGINS, baseURL])],
  };
}
