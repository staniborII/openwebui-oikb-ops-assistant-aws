const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler, noticeText, slackWebhookUrl } = require('../lambda/slack/index.js');

const WEBHOOK = 'https://hooks.slack.com/services/placeholder';

test('an alert is posted as the subject and the body', async () => {
  const posted = [];
  const handler = createHandler(
    async () => WEBHOOK,
    async (url, text) => {
      posted.push({ url, text });
      return { ok: true, status: 200, body: 'ok' };
    },
  );
  await handler({
    Records: [{ Sns: { Subject: 'oikb sync failed', Message: '{"status":"error"}' } }],
  });
  assert.deepEqual(posted, [{
    url: WEBHOOK,
    text: 'oikb sync failed\n\n{"status":"error"}',
  }]);
});

test('a webhook that is not Slack is refused before any post', async () => {
  let posted = false;
  const handler = createHandler(
    async () => 'https://example.com/services/hook',
    async () => {
      posted = true;
      return { ok: true, status: 200, body: 'ok' };
    },
  );
  await assert.rejects(handler({ Records: [{ Sns: { Message: 'down' } }] }), /Slack incoming webhook/);
  assert.equal(posted, false);
  assert.throws(() => slackWebhookUrl('https://hooks.slack.com/services/'), /Slack incoming webhook/);
});

test('a failed post raises the status and a long note is cut off', async () => {
  const posted = [];
  const handler = createHandler(
    async () => WEBHOOK,
    async (_url, text) => {
      posted.push(text);
      return { ok: false, status: 400, body: 'invalid_payload' };
    },
  );
  await assert.rejects(
    handler({ Records: [{ Sns: { Subject: 'Action needed: dev website', Message: 'The website is down.' } }] }),
    /Slack returned 400/,
  );
  assert.equal(posted[0].includes('hooks.slack.com'), false);
  assert.equal(noticeText('title', 'x'.repeat(50000)).length, 40000);
  assert.equal(noticeText('', ''), 'Alert');
});
