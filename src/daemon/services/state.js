const history = [];
const secrets = new Set();
let calibrationOffset = { x: 0, y: 0 };
let lastIdToXPath = {};

function record(action, args = {}) {
  history.push({ action, args, timestamp: new Date().toISOString() });
}

function getHistory() {
  return history;
}

function clearHistory() {
  history.length = 0;
}

function addSecret(value) {
  secrets.add(value);
}

function clearSecrets() {
  secrets.clear();
}

function resetAll() {
  clearHistory();
  clearSecrets();
  calibrationOffset = { x: 0, y: 0 };
  lastIdToXPath = {};
}

function maskSecrets(text) {
  let result = text;
  for (const secret of secrets) {
    while (result.includes(secret)) {
      result = result.replace(secret, '***');
    }
  }
  return result;
}

function getCalibrationOffset() {
  return { ...calibrationOffset };
}

function setCalibrationOffset(offset) {
  calibrationOffset = { ...offset };
}

function setIdToXPath(map) {
  lastIdToXPath = map;
}

function getXPathForId(id) {
  return lastIdToXPath[id];
}

function resolveSelector(selector) {
  if (!isNaN(selector) && !isNaN(parseFloat(selector))) {
    const xpath = lastIdToXPath[selector];
    if (!xpath) throw new Error('XPath not found for ID');
    return xpath;
  }
  return selector;
}

module.exports = {
  record,
  getHistory,
  clearHistory,
  addSecret,
  clearSecrets,
  maskSecrets,
  resetAll,
  getCalibrationOffset,
  setCalibrationOffset,
  setIdToXPath,
  getXPathForId,
  resolveSelector
};
