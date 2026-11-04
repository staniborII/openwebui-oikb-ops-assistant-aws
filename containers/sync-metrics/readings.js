// Turns one oikb /metrics page into the sync numbers CloudWatch should store.
const NAMESPACE = 'Chapters/Oikb';

const NAMES = {
  syncs: 'oikb_sync_total',
  errors: 'oikb_sync_errors_total',
  uploaded: 'oikb_files_uploaded_total',
  deleted: 'oikb_files_deleted_total',
  durationSum: 'oikb_sync_duration_seconds_sum',
  durationCount: 'oikb_sync_duration_seconds_count',
};

function parseMetrics(text) {
  const samples = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sample = parseLine(line);
    if (!sample || !Object.values(NAMES).includes(sample.name)) {
      continue;
    }
    samples.set(sampleKey(sample.name, sample.labels), sample);
  }
  return samples;
}

function changedSince(previous, current) {
  const delta = new Map();
  for (const [key, sample] of current) {
    const before = previous.get(key);
    const value = before === undefined || sample.value < before.value
      ? sample.value
      : sample.value - before.value;
    delta.set(key, { ...sample, value });
  }
  return delta;
}

function readingsFrom(delta) {
  const syncs = { success: 0, partial: 0, error: 0 };
  let errors = 0;
  let uploaded = 0;
  let deleted = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const sample of delta.values()) {
    if (sample.name === NAMES.syncs && Object.hasOwn(syncs, sample.labels.status)) {
      syncs[sample.labels.status] += sample.value;
    } else if (sample.name === NAMES.errors) {
      errors += sample.value;
    } else if (sample.name === NAMES.uploaded) {
      uploaded += sample.value;
    } else if (sample.name === NAMES.deleted) {
      deleted += sample.value;
    } else if (sample.name === NAMES.durationSum) {
      durationSum += sample.value;
    } else if (sample.name === NAMES.durationCount) {
      durationCount += sample.value;
    }
  }
  return {
    syncs,
    errors,
    uploaded,
    deleted,
    durationSeconds: durationCount > 0 ? durationSum / durationCount : null,
  };
}

function metricData(stage, readings) {
  const data = [
    count('Syncs', readings.syncs.success, stage, { Status: 'success' }),
    count('Syncs', readings.syncs.partial, stage, { Status: 'partial' }),
    count('Syncs', readings.syncs.error, stage, { Status: 'error' }),
    count('SyncErrors', readings.errors, stage),
    count('FilesUploaded', readings.uploaded, stage),
    count('FilesDeleted', readings.deleted, stage),
  ];
  if (readings.durationSeconds !== null) {
    data.push({
      MetricName: 'SyncDurationSeconds',
      Dimensions: [{ Name: 'Stage', Value: stage }],
      Value: readings.durationSeconds,
      Unit: 'Seconds',
    });
  }
  return data;
}

function count(name, value, stage, extra = {}) {
  return {
    MetricName: name,
    Dimensions: dimensions(stage, extra),
    Value: value,
    Unit: 'Count',
  };
}

function dimensions(stage, extra) {
  const pairs = { Stage: stage, ...extra };
  return Object.entries(pairs).map(([Name, Value]) => ({ Name, Value }));
}

function parseLine(line) {
  const match = /^([a-zA-Z_:][\w:]*)(\{.*\})?\s+(\S+)$/.exec(line);
  if (!match) {
    return null;
  }
  const value = Number(match[3]);
  if (!Number.isFinite(value)) {
    return null;
  }
  return { name: match[1], labels: parseLabels(match[2] || ''), value };
}

function parseLabels(body) {
  const labels = {};
  if (!body) {
    return labels;
  }
  const pattern = /([a-zA-Z_][\w]*)="((?:\\.|[^"\\])*)"/g;
  for (const match of body.slice(1, -1).matchAll(pattern)) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return labels;
}

function sampleKey(name, labels) {
  const body = Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join(',');
  return `${name}|${body}`;
}

module.exports = {
  NAMESPACE,
  parseMetrics,
  changedSince,
  readingsFrom,
  metricData,
};
