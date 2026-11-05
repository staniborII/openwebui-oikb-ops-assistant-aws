const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMetrics, versionFrom, totalsFrom, healthMetrics, secondsFrom, hungFromHealth, hungMetric, sourceRecords, historySince } = require('./readings');

const page = `
# HELP oikb_sync_total Total sync operations
# TYPE oikb_sync_total counter
oikb_sync_total{source="github:open-webui/oikb",status="success"} 2
oikb_sync_total{source="github:open-webui/oikb",status="error"} 1
oikb_sync_errors_total{source="github:open-webui/oikb"} 1
oikb_files_uploaded_total{source="github:open-webui/oikb"} 5
oikb_files_deleted_total{source="github:open-webui/oikb"} 1
oikb_sync_duration_seconds_bucket{source="github:open-webui/oikb",le="1.0"} 0
oikb_sync_duration_seconds_sum{source="github:open-webui/oikb"} 30
oikb_sync_duration_seconds_count{source="github:open-webui/oikb"} 3
oikb_info{version="0.6.0"} 1
`;

function named(data, name, value) {
  return data.find((item) => item.MetricName === name && item.Dimensions.some((dimension) => dimension.Value === value));
}

test('a metrics page keeps the sync series and the version', () => {
  const samples = parseMetrics(page);
  assert.equal(samples.size, 6);
  const success = [...samples.values()].find((sample) => sample.labels.status === 'success');
  assert.equal(success.value, 2);
  assert.equal(success.labels.source, 'github:open-webui/oikb');
  assert.equal(versionFrom(samples), '0.6.0');
});

test('the first metrics page is published as totals, including a status that has not happened', () => {
  const data = totalsFrom('dev', parseMetrics(page));
  assert.equal(named(data, 'SyncsFinished', 'success').Value, 2);
  assert.equal(named(data, 'SyncsFinished', 'error').Value, 1);
  assert.equal(named(data, 'SyncsFinished', 'partial').Value, 0);
  assert.equal(named(data, 'FilesUploadedTotal', 'github:open-webui/oikb').Value, 5);
  assert.equal(named(data, 'FilesDeletedTotal', 'github:open-webui/oikb').Value, 1);
  assert.equal(named(data, 'SyncErrorsTotal', 'github:open-webui/oikb').Value, 1);
  assert.ok(data.every((item) => item.Dimensions.some((dimension) => dimension.Name === 'Stage' && dimension.Value === 'dev')));
  assert.ok(data.every((item) => item.Dimensions.some((dimension) => dimension.Name === 'Source')));
});

test('a sync is hung only after it has been running for an hour', () => {
  const now = 1_700_000_000;
  const health = (status, startedAt) => ({ sources: { oikb: { status, started_at: startedAt } } });
  assert.equal(hungFromHealth(health('running', now - 30 * 60), now), 0);
  assert.equal(hungFromHealth(health('running', now - 60 * 60), now), 1);
  assert.equal(hungFromHealth(health('success', now - 3 * 60 * 60), now), 0);
  assert.equal(hungFromHealth({ sources: { oikb: { status: 'running' } } }, now), 0);
  assert.equal(hungFromHealth({ status: 'ok' }, now), null);
  assert.equal(hungMetric('dev', 1).MetricName, 'SyncRunningTooLong');
  assert.equal(hungMetric('dev', 1).Value, 1);
});

test('health becomes the numbers on the dashboard', () => {
  const now = 1_000;
  const records = sourceRecords({
    sources: {
      'github:open-webui/oikb': {
        status: 'success',
        last_sync: 700,
        duration_ms: 908,
        files_added: 2,
        files_modified: 1,
        files_deleted: 0,
        next_sync_in: '900s',
      },
    },
  });
  const data = healthMetrics('dev', records, now);
  assert.equal(named(data, 'SyncReport', 'dev').Value, 1);
  assert.equal(named(data, 'SecondsSinceLastSync', 'github:open-webui/oikb').Value, 300);
  assert.equal(named(data, 'LastSyncDurationSeconds', 'github:open-webui/oikb').Value, 0.908);
  assert.equal(named(data, 'FilesAdded', 'github:open-webui/oikb').Value, 2);
  assert.equal(named(data, 'FilesModified', 'github:open-webui/oikb').Value, 1);
  assert.equal(named(data, 'FilesRemoved', 'github:open-webui/oikb').Value, 0);
  assert.equal(named(data, 'NextSyncInSeconds', 'github:open-webui/oikb').Value, 900);
  assert.equal(secondsFrom('1h30m'), 5400);
  assert.equal(secondsFrom(''), null);
});

test('health becomes a status record, and a finished sync is history once', () => {
  const body = {
    sources: {
      'github:open-webui/oikb': {
        name: 'oikb',
        status: 'running',
        started_at: 100,
        next_sync_in: '900s',
      },
    },
  };
  const running = sourceRecords(body);
  assert.equal(running[0].status, 'running');
  assert.equal(running[0].started_at, 100);
  assert.equal(historySince(new Map(), running).events.length, 0);

  const finished = sourceRecords({
    sources: {
      'github:open-webui/oikb': {
        name: 'oikb',
        status: 'success',
        last_sync: 200,
        duration_ms: 1500,
        files_added: 2,
        errors: ['one'],
      },
    },
  });
  const first = historySince(new Map(), finished);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].files_added, 2);
  assert.equal(first.events[0].error, 'one');
  assert.equal(historySince(first.next, finished).events.length, 0);
  assert.equal(sourceRecords({ status: 'ok' }), null);
});
