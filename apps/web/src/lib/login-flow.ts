type BetterAuthError = {
  status?: number;
};

type SignInEmail = (credentials: {
  email: string;
  password: string;
}) => Promise<{
  error?: BetterAuthError | null;
}>;

type LoginResult =
  | { ok: true }
  | { ok: false; message: string };

export async function authenticateWithEmail(
  email: string,
  password: string,
  signInEmail: SignInEmail,
): Promise<LoginResult> {
  try {
    const result = await signInEmail({ email, password });

    if (!result.error) {
      return { ok: true };
    }

    if (result.error.status === 401) {
      return { ok: false, message: '邮箱或密码错误' };
    }

    return { ok: false, message: '登录失败，请稍后重试' };
  } catch {
    return { ok: false, message: '登录服务暂时不可用，请稍后重试' };
  }
}
