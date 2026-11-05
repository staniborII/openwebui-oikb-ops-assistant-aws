// Reads the daemon's Prometheus page and health page and stores the current numbers in CloudWatch.
const http = require('http');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { NAMESPACE, parseMetrics, versionFrom, totalsFrom, healthMetrics, hungFromHealth, hungMetric, sourceRecords, historySince } = require('./readings');

const region = process.env.AWS_REGION;
const stage = process.env.STAGE;
const metricsUrl = 'http://127.0.0.1:8080/metrics';
const healthUrl = 'http://127.0.0.1:8080/health';
const intervalMs = 60_000;

if (!region || !stage) {
  console.error('AWS_REGION and STAGE are required.');
  process.exit(1);
}

const cloudwatch = new CloudWatchClient({ region });
let previous = new Map();
let seenVersion = '';
let lastHung = 0;
let seenSyncs = new Map();

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
  }
  try {
    await publishHung();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`The hung-sync reading was not published. ${message}`);
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
  const version = versionFrom(current);
  if (version && version !== seenVersion) {
    seenVersion = version;
    console.log(`sync-version ${version}`);
  }
  const data = totalsFrom(stage, current);
  if (data.length === 0) {
    console.error('The metrics page had no sync series.');
    return;
  }
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: data,
  }));
  if (!sameSamples(previous, current)) {
    console.log('Published sync totals.');
  }
  previous = current;
}

function sameSamples(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, sample] of right) {
    const before = left.get(key);
    if (!before || before.value !== sample.value) {
      return false;
    }
  }
  return true;
}

async function publishHung() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`The health page returned ${response.status}.`);
    }
    const body = await response.json();
    const reading = hungFromHealth(body, Date.now() / 1000);
    const records = sourceRecords(body);
    if (reading === null || records === null) {
      throw new Error('The health page had no source list.');
    }
    lastHung = reading;
    const history = historySince(seenSyncs, records);
    seenSyncs = history.next;
    for (const record of records) {
      console.log(`sync-status ${JSON.stringify(record)}`);
    }
    for (const record of history.events) {
      console.log(historyLine(record));
    }
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [hungMetric(stage, lastHung), ...healthMetrics(stage, records, Date.now() / 1000)],
    }));
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sync health was not read. Keeping the last hung reading. ${message}`);
  }
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: [hungMetric(stage, lastHung)],
  }));
}

function historyLine(record) {
  const duration = record.duration_ms === null ? '' : String(record.duration_ms);
  const error = record.error.replace(/\s+/g, ' ').trim();
  return `sync-history status=${record.status} duration_ms=${duration} added=${record.files_added} modified=${record.files_modified} deleted=${record.files_deleted} error=${error}`;
}
