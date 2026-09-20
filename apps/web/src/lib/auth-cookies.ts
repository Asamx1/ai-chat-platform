export type AuthCookieEnvironment = {
  AICHAT_SECURE_COOKIES?: string | undefined;
};

export type SecureCookieOriginConfig = {
  baseURL: string;
};

export function resolveUseSecureCookies(
  env: AuthCookieEnvironment,
  originConfig: SecureCookieOriginConfig,
): boolean {
  if (env.AICHAT_SECURE_COOKIES === '1') return true;
  return new URL(originConfig.baseURL).protocol === 'https:';
}
