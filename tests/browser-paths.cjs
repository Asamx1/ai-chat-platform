const fs = require('node:fs');
const path = require('node:path');
function executableCandidates(env = process.env) {
  return [env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_PATH,
    ...(env.EXECUTABLE_CANDIDATES ? env.EXECUTABLE_CANDIDATES.split(path.delimiter) : []),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
}
function browserExecutable(env = process.env) {
  const found = executableCandidates(env).find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  });
  if (!found) throw new Error('No executable browser found; set PUPPETEER_EXECUTABLE_PATH, CHROME_PATH or EXECUTABLE_CANDIDATES.');
  return found;
}
function artifactDir(env = process.env) {
  const dir = env.E2E_ARTIFACT_DIR || path.resolve(__dirname, '../.tmp/e2e');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
module.exports = { executableCandidates, browserExecutable, artifactDir };
