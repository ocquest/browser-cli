const http = require('http');
const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, '../../daemon.pid');
const PORT = 3030;

function getRunningPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return null;
  }
}

function send(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let out = '';
      res.on('data', chunk => out += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(out);
        } else {
          resolve(out);
        }
      });
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        reject('Daemon is not running. Please start it with "br start".');
      } else {
        console.log('Unknown error, try start the daemon with "br start":');
        console.error(e);
      }
    });
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { send, getRunningPid, PORT, PID_FILE };
