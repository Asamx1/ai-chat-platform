import type { authenticateWithEmail } from '@/lib/login-flow';

const NAVIGATION_RECOVERY_MS = 1500;

type Authenticate = typeof authenticateWithEmail;
type SignInEmail = Parameters<Authenticate>[2];

export type LoginControllerDependencies = {
  authenticate: Authenticate;
  signInEmail: SignInEmail;
  replace: (path: string) => void;
  refresh: () => void;
  setPending: (pending: boolean) => void;
  setError: (message: string) => void;
  scheduleRecovery: (callback: () => void, delayMs: number) => () => void;
};

export type LoginController = {
  submit: (email: string, password: string) => Promise<void>;
  dispose: () => void;
};

export type LoginControllerSlot = {
  current: LoginController | null;
};

export function installLoginController(
  slot: LoginControllerSlot,
  dependencies: LoginControllerDependencies,
): () => void {
  const controller = createLoginController(dependencies);
  slot.current = controller;

  return () => {
    controller.dispose();
    if (slot.current === controller) {
      slot.current = null;
    }
  };
}

export function createLoginController({
  authenticate,
  signInEmail,
  replace,
  refresh,
  setPending,
  setError,
  scheduleRecovery,
}: LoginControllerDependencies): LoginController {
  let pending = false;
  let disposed = false;
  let cancelRecovery: (() => void) | undefined;

  function releasePending() {
    if (disposed) {
      return;
    }

    pending = false;
    setPending(false);
  }

  return {
    async submit(email, password) {
      if (pending || disposed) {
        return;
      }

      pending = true;
      setPending(true);
      setError('');
      let navigationStarted = false;

      try {
        const result = await authenticate(email.trim(), password, signInEmail);

        if (disposed) {
          return;
        }

        if (!result.ok) {
          setError(result.message);
          return;
        }

        navigationStarted = true;
        replace('/');
        refresh();
      } finally {
        if (navigationStarted) {
          cancelRecovery = scheduleRecovery(releasePending, NAVIGATION_RECOVERY_MS);
        } else {
          releasePending();
        }
      }
    },
    dispose() {
      disposed = true;
      cancelRecovery?.();
      cancelRecovery = undefined;
    },
  };
}
