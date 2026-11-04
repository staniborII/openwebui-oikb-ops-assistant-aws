const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler } = require('../lambda/notify/index.js');

test('a sync failure is published with a fixed subject', async () => {
  const sent = [];
  const previous = process.env.TOPIC_ARN;
  process.env.TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:chapters-alerts-dev';
  try {
    const handler = createHandler(async (input) => {
      sent.push(input);
    });
    const result = await handler({ body: '{"status":"error","source":"github:open-webui/oikb"}' });
    assert.deepEqual(result, { statusCode: 200, body: 'ok' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].TopicArn, process.env.TOPIC_ARN);
    assert.equal(sent[0].Subject, 'oikb sync failed');
    assert.equal(sent[0].Message, '{"status":"error","source":"github:open-webui/oikb"}');
  } finally {
    if (previous === undefined) {
      delete process.env.TOPIC_ARN;
    } else {
      process.env.TOPIC_ARN = previous;
    }
  }
});

test('a non-string event is sent as text and long bodies are cut off', async () => {
  const sent = [];
  process.env.TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:chapters-alerts-dev';
  const handler = createHandler(async (input) => {
    sent.push(input);
  });
  await handler({ source: 'oikb' });
  assert.equal(sent[0].Message, JSON.stringify({ source: 'oikb' }));

  await handler({ body: 'x'.repeat(100050) });
  assert.equal(sent[1].Message.length, 100000);
  assert.equal(sent[1].Subject, 'oikb sync failed');
});
