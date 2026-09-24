export function acquireSingleInstance(app: { requestSingleInstanceLock(): boolean; quit(): void }): boolean {
  if (app.requestSingleInstanceLock()) return true;
  app.quit();
  return false;
}
