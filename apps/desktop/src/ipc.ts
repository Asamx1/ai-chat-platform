import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  probe: () => ipcRenderer.invoke('desktop:probe'),
  startWeb: () => ipcRenderer.invoke('desktop:startWeb'),
  openVaultFolder: () => ipcRenderer.invoke('desktop:openVaultFolder'),
  getState: () => ipcRenderer.invoke('desktop:getState'),
  onDockerDependencyDown: (callback: (dependencies: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dependencies: unknown) => callback(dependencies);
    ipcRenderer.on('docker-dependency-down', listener);
    return () => ipcRenderer.removeListener('docker-dependency-down', listener);
  },
});
