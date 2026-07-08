const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { send, getRunningPid, PID_FILE } = require('../send');

module.exports = function (program) {
  program
    .command('start')
    .description('Start the headless browser daemon process.')
    .option('-k, --api-key <key>', 'API key for LLM features (also via BR_LLM_API_KEY env var)')
    .option('-p, --proxy <url>', 'Proxy URL to use (e.g. http://user:pass@host:port). Default: no proxy.')
    .action(async (opts) => {
      const pid = getRunningPid();
      if (pid) {
        try {
          const health = await send('/health');
          if (health === 'ok') {
            console.log('Daemon is already running.');
            return;
          }
        } catch (err) {
          console.log('Found stale daemon process, attempting to stop it...');
          try {
            process.kill(pid);
            fs.unlinkSync(PID_FILE);
            console.log('Stale daemon stopped.');
          } catch (killErr) {
            console.error('Failed to stop stale daemon, please check for zombie processes.');
            return;
          }
        }
      }

      const env = { ...process.env };
      if (opts.apiKey) env.BR_LLM_API_KEY = opts.apiKey;
      if (opts.proxy) env.BR_PROXY = opts.proxy;

      const child = spawn(process.execPath, [path.join(__dirname, '../../daemon.js')], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env
      });

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        console.error('Daemon failed to start in a timely manner.');
        if (stderr.trim()) console.error('Error output:\n', stderr.trim());
        process.exit(1);
      }, 5000);

      child.stdout.on('data', data => {
        stdout += data.toString();
        if (stdout.includes('br daemon running')) {
          clearTimeout(timeout);
          fs.writeFileSync(PID_FILE, String(child.pid));
          child.unref();
          console.log('Daemon started successfully.');
          process.exit(0);
        }
      });

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('exit', code => {
        if (stdout.includes('br daemon running')) return;
        clearTimeout(timeout);
        console.error(`Daemon exited unexpectedly with code ${code}.`);
        if (stderr.trim()) console.error('Error output:\n', stderr.trim());
        process.exit(1);
      });
    });

  program
    .command('stop')
    .description('Stop the headless browser daemon process.')
    .action(() => {
      const pid = getRunningPid();
      if (!pid) {
        console.log('Daemon is not running.');
        return;
      }
      try {
        process.kill(pid);
        fs.unlinkSync(PID_FILE);
        console.log('Daemon stopped.');
      } catch (err) {
        console.error('Failed to stop daemon:', err.message);
      }
    });
};
