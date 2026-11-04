// Reads the daemon's Prometheus page and stores sync changes in CloudWatch.
const http = require('http');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { NAMESPACE, parseMetrics, changedSince, readingsFrom, metricData } = require('./readings');

const region = process.env.AWS_REGION;
const stage = process.env.STAGE;
const metricsUrl = 'http://127.0.0.1:8080/metrics';
const intervalMs = 60_000;

if (!region || !stage) {
  console.error('AWS_REGION and STAGE are required.');
  process.exit(1);
}

const cloudwatch = new CloudWatchClient({ region });
let previous = new Map();
let baseline = false;

const server = http.createServer((request, response) => {
  const ok = request.method === 'GET' && request.url === '/health';
  response.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
  response.end(ok ? 'ok' : 'Not found');
});
server.listen(8091, '127.0.0.1', () => {
  console.log('Listening on 127.0.0.1:8091');
});

setTimeout(tick, 0);

async function tick() {
  try {
    await publish();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sync metrics were not published. ${message}`);
  } finally {
    setTimeout(tick, intervalMs);
  }
}

async function publish() {
  const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`The metrics page returned ${response.status}.`);
  }
  const current = parseMetrics(await response.text());
  if (!baseline) {
    previous = current;
    baseline = true;
    console.log('Recorded the first metrics page. Later changes are published.');
    return;
  }
  const readings = readingsFrom(changedSince(previous, current));
  previous = current;
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: metricData(stage, readings),
  }));
  if (readings.durationSeconds !== null || readings.errors > 0 || readings.uploaded > 0 || readings.deleted > 0) {
    console.log('Published a sync change.');
  }
}
