const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILES_DIR = path.join(os.homedir(), '.config', 'browser-cli', 'profiles');

function ensureDir() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function normalizeDomain(domain) {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
}

function getDomainFromUrl(url) {
  try { return normalizeDomain(new URL(url).hostname); } catch { return normalizeDomain(url); }
}

function getFilePath(domain) {
  return path.join(PROFILES_DIR, getDomainFromUrl(domain) + '.json');
}

function loadTools(domain) {
  ensureDir();
  const fp = getFilePath(domain);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

function saveTools(domain, tools) {
  ensureDir();
  fs.writeFileSync(getFilePath(domain), JSON.stringify(tools, null, 2));
}

function listDomains() {
  ensureDir();
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

module.exports = {
  getDomainFromUrl,
  loadTools,
  saveTools,
  listDomains,
  PROFILES_DIR
};
