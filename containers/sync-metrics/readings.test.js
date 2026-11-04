const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMetrics, changedSince, readingsFrom, metricData } = require('./readings');

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

test('a metrics page keeps the sync series and drops the rest', () => {
  const samples = parseMetrics(page);
  assert.equal(samples.size, 7);
  const success = [...samples.values()].find((sample) => sample.labels.status === 'success');
  assert.equal(success.value, 2);
  assert.equal(success.labels.source, 'github:open-webui/oikb');
});

test('changes since the last page become one set of readings', () => {
  const first = parseMetrics(page);
  const later = parseMetrics(page
    .replace('status="success"} 2', 'status="success"} 3')
    .replace('oikb_files_uploaded_total{source="github:open-webui/oikb"} 5', 'oikb_files_uploaded_total{source="github:open-webui/oikb"} 8')
    .replace('oikb_sync_duration_seconds_sum{source="github:open-webui/oikb"} 30', 'oikb_sync_duration_seconds_sum{source="github:open-webui/oikb"} 42')
    .replace('oikb_sync_duration_seconds_count{source="github:open-webui/oikb"} 3', 'oikb_sync_duration_seconds_count{source="github:open-webui/oikb"} 4'));
  const readings = readingsFrom(changedSince(first, later));
  assert.deepEqual(readings.syncs, { success: 1, partial: 0, error: 0 });
  assert.equal(readings.uploaded, 3);
  assert.equal(readings.deleted, 0);
  assert.equal(readings.durationSeconds, 12);
});

test('a restarted counter is counted from zero instead of going backwards', () => {
  const first = parseMetrics('oikb_sync_total{source="github:open-webui/oikb",status="success"} 9\n');
  const restarted = parseMetrics('oikb_sync_total{source="github:open-webui/oikb",status="success"} 1\n');
  const readings = readingsFrom(changedSince(first, restarted));
  assert.equal(readings.syncs.success, 1);
  assert.equal(readings.durationSeconds, null);
});

test('CloudWatch data names the stage and leaves duration out until a sync finishes', () => {
  const readings = readingsFrom(changedSince(new Map(), parseMetrics(page)));
  const data = metricData('dev', readings);
  assert.equal(data.find((item) => item.MetricName === 'Syncs' && item.Dimensions.some((dimension) => dimension.Value === 'success')).Value, 2);
  assert.equal(data.find((item) => item.MetricName === 'SyncDurationSeconds').Value, 10);
  const quiet = metricData('dev', readingsFrom(changedSince(parseMetrics(page), parseMetrics(page))));
  assert.equal(quiet.find((item) => item.MetricName === 'SyncDurationSeconds'), undefined);
  assert.equal(quiet.find((item) => item.MetricName === 'SyncErrors').Value, 0);
  assert.ok(quiet.every((item) => item.Dimensions.some((dimension) => dimension.Name === 'Stage' && dimension.Value === 'dev')));
});
