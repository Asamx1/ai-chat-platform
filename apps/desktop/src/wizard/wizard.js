const element = id => document.getElementById(id);
const api = window.desktop;
const report = error => { element('message').textContent = error.message || String(error); };
async function refresh() {
  element('refresh').disabled = true;
  element('start').disabled = true;
  try {
    const state = await api.getState();
    element('vault').textContent = state.vaultPath;
    element('warning').hidden = state.vaultExists;
    element('warning').textContent = '资料目录不存在。请准备该目录，或通过 AICHAT_VAULT_PATH 配置已有目录后重新启动。';
    element('open').disabled = !state.vaultExists;
    const health = await api.probe();
    element('dependencies').replaceChildren(...health.map(item => {
      const li = document.createElement('li');
      li.textContent = `${item.name}：${item.state === 'up' ? '可用' : '不可用'} — ${item.detail}`;
      return li;
    }));
    const missing = health.some(item => item.name !== 'web' && item.state === 'down');
    element('docker').hidden = !missing;
    element('start').disabled = missing || !state.webAvailable;
    element('message').textContent = state.webAvailable ? '' : '未找到开发仓库。请设置 AICHAT_REPO_ROOT 后重新启动。';
  } catch (error) { report(error); }
  finally { element('refresh').disabled = false; }
}
api.onDockerDependencyDown(() => { element('docker').hidden = false; });
element('refresh').onclick = refresh;
element('open').onclick = () => api.openVaultFolder().catch(report);
element('start').onclick = async () => {
  element('start').disabled = true;
  element('refresh').disabled = true;
  element('message').textContent = '正在启动，等待 /login 就绪…';
  try { await api.startWeb(); }
  catch (error) { report(error); element('start').disabled = false; }
  finally { element('refresh').disabled = false; }
};
void refresh();
