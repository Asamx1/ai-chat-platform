import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from 'dotenv';
import { ServiceManager } from './services/service-manager';
import { acquireSingleInstance } from './single-instance';

const webURL = 'http://localhost:3001';
const wizardPath = join(__dirname, '../src/wizard/index.html');
let window: BrowserWindow | undefined;
let manager: ServiceManager;
let quitting = false;

if (acquireSingleInstance(app)) {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  void app.whenReady().then(async () => {
    const repoRoot = process.env.AICHAT_REPO_ROOT || resolve(__dirname, '../../..');
    config({ path: join(repoRoot, '.env'), quiet: true });
    const vault = process.env.AICHAT_VAULT_PATH || 'D:\\wiki-vault';
    const vaultExists = () => {
      try { return statSync(vault).isDirectory(); } catch { return false; }
    };
    manager = new ServiceManager({ repoRoot, userData: app.getPath('userData') });
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      const url = event.senderFrame?.url;
      if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame ||
        !(url === pathToFileURL(wizardPath).href || (url && new URL(url).origin === webURL))) {
        throw new Error('IPC sender rejected');
      }
    };
    ipcMain.handle('desktop:probe', event => { trusted(event); return manager.probe(); });
    ipcMain.handle('desktop:getState', event => {
      trusted(event);
      return { ...manager.getState(), vaultPath: vault, vaultExists: vaultExists(),
        webAvailable: existsSync(join(repoRoot, 'apps/web/package.json')) };
    });
    ipcMain.handle('desktop:openVaultFolder', async event => {
      trusted(event);
      if (!vaultExists()) throw new Error('Vault 目录不存在；请在设置的路径准备目录后重试。');
      const error = await shell.openPath(vault);
      if (error) throw new Error(error);
    });
    ipcMain.handle('desktop:startWeb', async event => {
      trusted(event);
      await manager.startWeb();
      await window?.loadURL(webURL + '/login');
    });
    manager.on('docker-dependency-down', dependencies => {
      window?.webContents.send('docker-dependency-down', dependencies);
    });
    const createWindow = async () => {
      window = new BrowserWindow({ width: 1400, height: 900, minWidth: 1024, minHeight: 700,
        webPreferences: { preload: join(__dirname, 'ipc.js'), contextIsolation: true,
          nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (url !== pathToFileURL(wizardPath).href && new URL(url).origin !== webURL) event.preventDefault();
      });
      window.on('closed', () => { window = undefined; });
      await window.loadFile(wizardPath);
    };
    app.on('activate', () => { if (!window) void createWindow(); });
    await createWindow();
  }).catch(error => { console.error('Desktop initialization failed', error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !manager) return;
    event.preventDefault();
    quitting = true;
    void manager.stopAll().catch(error => console.error('Desktop cleanup failed', error)).finally(() => app.quit());
  });
}
