// Turns one oikb /metrics page and one /health page into CloudWatch numbers.
const NAMESPACE = 'Chapters/Oikb';
const HUNG_AFTER_SECONDS = 60 * 60;
const STATUSES = ['success', 'partial', 'error'];

const NAMES = {
  syncs: 'oikb_sync_total',
  errors: 'oikb_sync_errors_total',
  uploaded: 'oikb_files_uploaded_total',
  deleted: 'oikb_files_deleted_total',
  info: 'oikb_info',
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

function versionFrom(samples) {
  for (const sample of samples.values()) {
    if (sample.name === NAMES.info && sample.labels.version) {
      return sample.labels.version;
    }
  }
  return '';
}

function totalsFrom(stage, samples) {
  const sources = new Set();
  for (const sample of samples.values()) {
    if (sample.labels.source) {
      sources.add(sample.labels.source);
    }
  }
  const data = [];
  for (const source of sources) {
    const extra = { Source: source };
    for (const status of STATUSES) {
      data.push(count('SyncsFinished', valueOf(samples, NAMES.syncs, { source, status }), stage, { ...extra, Status: status }));
    }
    data.push(count('FilesUploadedTotal', valueOf(samples, NAMES.uploaded, { source }), stage, extra));
    data.push(count('FilesDeletedTotal', valueOf(samples, NAMES.deleted, { source }), stage, extra));
    data.push(count('SyncErrorsTotal', valueOf(samples, NAMES.errors, { source }), stage, extra));
  }
  return data;
}

function healthMetrics(stage, records, nowSeconds) {
  const data = [count('SyncReport', 1, stage)];
  for (const record of records) {
    const extra = { Source: record.source };
    data.push(count('FilesAdded', record.files_added, stage, extra));
    data.push(count('FilesModified', record.files_modified, stage, extra));
    data.push(count('FilesRemoved', record.files_deleted, stage, extra));
    if (record.last_sync !== null) {
      data.push(seconds('SecondsSinceLastSync', Math.max(0, nowSeconds - record.last_sync), stage, extra));
    }
    if (record.duration_ms !== null) {
      data.push(seconds('LastSyncDurationSeconds', record.duration_ms / 1000, stage, extra));
    }
    const next = secondsFrom(record.next_sync_in);
    if (next !== null) {
      data.push(seconds('NextSyncInSeconds', next, stage, extra));
    }
  }
  return data;
}

function secondsFrom(text) {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let total = 0;
  let found = false;
  for (const match of text.matchAll(pattern)) {
    found = true;
    const amount = Number(match[1]);
    total += match[2] === 'h' ? amount * 3600 : match[2] === 'm' ? amount * 60 : amount;
  }
  return found ? total : null;
}

function valueOf(samples, name, labels) {
  const sample = samples.get(sampleKey(name, labels));
  return sample ? sample.value : 0;
}

function hungFromHealth(body, nowSeconds, limitSeconds = HUNG_AFTER_SECONDS) {
  const sources = body && typeof body.sources === 'object' && body.sources ? Object.values(body.sources) : null;
  if (!sources) {
    return null;
  }
  for (const source of sources) {
    if (!source || source.status !== 'running') {
      continue;
    }
    const started = Number(source.started_at);
    if (!Number.isFinite(started) || started <= 0) {
      continue;
    }
    if (nowSeconds - started >= limitSeconds) {
      return 1;
    }
  }
  return 0;
}

function hungMetric(stage, value) {
  return count('SyncRunningTooLong', value, stage);
}

const FINISHED = new Set(['success', 'partial', 'error', 'cancelled']);

function sourceRecords(body) {
  const sources = body && typeof body.sources === 'object' && body.sources ? body.sources : null;
  if (!sources) {
    return null;
  }
  return Object.entries(sources).map(([key, source]) => ({
    source: key,
    name: source && typeof source.name === 'string' && source.name ? source.name : key,
    status: source && typeof source.status === 'string' ? source.status : 'unknown',
    started_at: clock(source && source.started_at),
    last_sync: clock(source && source.last_sync),
    duration_ms: clock(source && source.duration_ms),
    files_added: whole(source && source.files_added),
    files_modified: whole(source && source.files_modified),
    files_deleted: whole(source && source.files_deleted),
    error: errorText(source).slice(0, 500),
    next_sync_in: source && typeof source.next_sync_in === 'string' ? source.next_sync_in : '',
  }));
}

function historySince(previous, records) {
  const next = new Map(previous);
  const events = [];
  for (const record of records) {
    const seen = previous.get(record.source);
    if (FINISHED.has(record.status) && record.last_sync !== null && record.last_sync !== seen) {
      events.push(record);
    }
    if (record.last_sync !== null) {
      next.set(record.source, record.last_sync);
    }
  }
  return { next, events };
}

function clock(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function errorText(source) {
  if (!source) {
    return '';
  }
  if (typeof source.error === 'string' && source.error) {
    return source.error;
  }
  if (Array.isArray(source.errors)) {
    return source.errors.filter((item) => typeof item === 'string' && item).join('; ');
  }
  return '';
}

function count(name, value, stage, extra = {}) {
  return point(name, value, stage, extra, 'Count');
}

function seconds(name, value, stage, extra = {}) {
  return point(name, value, stage, extra, 'Seconds');
}

function point(name, value, stage, extra, unit) {
  return {
    MetricName: name,
    Dimensions: dimensions(stage, extra),
    Value: value,
    Unit: unit,
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
  HUNG_AFTER_SECONDS,
  parseMetrics,
  versionFrom,
  totalsFrom,
  healthMetrics,
  secondsFrom,
  hungFromHealth,
  hungMetric,
  sourceRecords,
  historySince,
};
