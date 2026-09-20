export type AuthCookieEnvironment = {
  AICHAT_LOCAL_SMOKE?: string;
  AICHAT_SECURE_COOKIES?: string;
  NODE_ENV?: string;
};

export function resolveUseSecureCookies(
  env: AuthCookieEnvironment,
): boolean {
  if (env.AICHAT_SECURE_COOKIES === '1') return true;
  if (env.AICHAT_LOCAL_SMOKE === '1') return false;
  return env.NODE_ENV === 'production';
}
