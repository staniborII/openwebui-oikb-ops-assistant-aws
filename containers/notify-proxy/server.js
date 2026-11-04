// Signs the daemon's failure post with the task role and sends it to the notify function.
const http = require('http');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');

const port = 8089;
const target = process.env.FUNCTION_URL;
const region = process.env.AWS_REGION;
const maxBytes = 100000;

if (!target || !region) {
  console.error('FUNCTION_URL and AWS_REGION are required.');
  process.exit(1);
}

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region,
  service: 'lambda',
  sha256: Sha256,
});

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }
  try {
    const body = await readBody(request);
    const status = await forward(body);
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(status === 200 ? 'ok' : 'The sync alert could not be sent.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sync alert was not sent. ${message}`);
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('The sync alert could not be sent.');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Listening on 127.0.0.1:${port}`);
});

async function forward(body) {
  const url = new URL(target);
  const signed = await signer.sign(new HttpRequest({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: {
      host: url.hostname,
      'content-type': 'application/json',
    },
    body,
  }));
  const headers = flatten(signed.headers);
  delete headers.host;
  delete headers['content-length'];
  const upstream = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!upstream.ok) {
    console.error(`Sync alert was rejected with status ${upstream.status}.`);
  }
  return upstream.status;
}

function flatten(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return out;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('The sync alert was larger than 100 KB.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
