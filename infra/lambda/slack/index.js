// Posts one alerts-topic message to a Slack incoming webhook. The URL stays in Secrets Manager.
const MAX_TEXT = 40000;

function slackWebhookUrl(secret) {
  let url;
  try {
    url = new URL(typeof secret === 'string' ? secret.trim() : '');
  } catch {
    throw new Error('Slack webhook URL is not a Slack incoming webhook.');
  }
  const pathOk = url.pathname.startsWith('/services/') && url.pathname.length > '/services/'.length;
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' || !pathOk || url.username || url.password || url.search || url.hash) {
    throw new Error('Slack webhook URL is not a Slack incoming webhook.');
  }
  return url.toString();
}

function noticeText(subject, message) {
  const parts = [subject, message].filter((part) => typeof part === 'string' && part.length > 0);
  return (parts.join('\n\n') || 'Alert').slice(0, MAX_TEXT);
}

function createHandler(readSecret, post) {
  return async (event) => {
    const url = slackWebhookUrl(await readSecret());
    const records = Array.isArray(event?.Records) ? event.Records : [];
    for (const record of records) {
      const note = record?.Sns ?? {};
      const response = await post(url, noticeText(note.Subject, note.Message));
      const body = typeof response?.body === 'string' ? response.body.trim() : '';
      if (!response?.ok || body !== 'ok') {
        throw new Error(`Slack returned ${response?.status ?? 'no status'}`);
      }
    }
  };
}

async function postToSlack(url, text) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Slack request failed');
  }
  return { ok: response.ok, status: response.status, body: await response.text() };
}

exports.slackWebhookUrl = slackWebhookUrl;
exports.noticeText = noticeText;
exports.createHandler = createHandler;
exports.handler = async (event) => {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  return createHandler(async () => {
    const result = await client.send(new GetSecretValueCommand({
      SecretId: process.env.WEBHOOK_SECRET_ARN,
    }));
    return result.SecretString;
  }, postToSlack)(event);
};
