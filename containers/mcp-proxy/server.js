// Adds the GitHub token and forwards to the MCP process on this task. Open WebUI never sees the token.
const http = require('http');
const net = require('net');

const listenPort = 8082;
const upstreamHost = '127.0.0.1';
const upstreamPort = 8083;
const token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '').trim();
const hopByHop = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
];

if (!token) {
  console.error('GITHUB_PERSONAL_ACCESS_TOKEN is required.');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    probe().then((ready) => {
      response.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
      response.end(ready ? 'ok' : 'GitHub MCP is not ready.');
    });
    return;
  }

  const headers = withoutHopByHop(request.headers);
  delete headers.authorization;
  delete headers.host;
  headers.authorization = `Bearer ${token}`;
  headers.host = `${upstreamHost}:${upstreamPort}`;

  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, withoutHopByHop(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );
  upstream.setTimeout(120000, () => {
    upstream.destroy(new Error('GitHub MCP did not answer within 120 seconds.'));
  });
  upstream.on('error', (error) => {
    console.error(`GitHub MCP request failed. ${error.message}`);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('GitHub MCP is not ready.');
  });
  request.on('error', () => upstream.destroy());
  request.pipe(upstream);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${listenPort}`);
});

function withoutHopByHop(headers) {
  const copy = { ...headers };
  for (const name of hopByHop) {
    delete copy[name];
  }
  return copy;
}

function probe() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: upstreamHost, port: upstreamPort });
    const done = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
