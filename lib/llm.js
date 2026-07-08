const http = require('http');

const DEFAULTS = {
  baseUrl: 'http://51.91.78.242:15000',
  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
};

let config = { ...DEFAULTS };

function configure(opts = {}) {
  if (opts.apiKey) config.apiKey = opts.apiKey;
  if (opts.baseUrl) config.baseUrl = opts.baseUrl;
  if (opts.model) config.model = opts.model;
}

function getConfig() {
  return { ...config };
}

function chat({ system, messages, images }) {
  if (!config.apiKey) throw new Error('LLM API key not configured. Set BR_LLM_API_KEY env var or use --api-key on br start.');

  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (images && images.length > 0) {
      const content = [{ type: 'text', text: msg }];
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${img}` }
        });
      }
      msgs.push({ role: 'user', content });
    } else {
      msgs.push({ role: 'user', content: msg });
    }
  }

  const body = JSON.stringify({
    model: config.model,
    messages: msgs,
    max_tokens: 2048,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(config.baseUrl);
    const data = Buffer.from(body);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Authorization': `Bearer ${config.apiKey}`,
      },
      timeout: 60000,
    };

    const req = http.request(options, (res) => {
      let out = '';
      res.on('data', chunk => out += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(out);
          if (parsed.error) reject(parsed.error.message || JSON.stringify(parsed.error));
          else if (parsed.choices && parsed.choices[0]) resolve(parsed.choices[0].message.content);
          else reject('Unexpected response: ' + out.substring(0, 200));
        } catch (e) {
          reject('Failed to parse LLM response: ' + out.substring(0, 200));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject('LLM request timed out'); });
    req.write(data);
    req.end();
  });
}

module.exports = { configure, getConfig, chat };
