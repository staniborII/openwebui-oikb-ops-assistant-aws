// Publishes an oikb sync failure to the alerts topic. Only the daemon task role may call the function URL.
const MAX_MESSAGE = 100000;

function failureNotice(event) {
  const body = typeof event.body === 'string' ? event.body : JSON.stringify(event);
  return {
    Subject: 'oikb sync failed',
    Message: body.slice(0, MAX_MESSAGE),
  };
}

function createHandler(send) {
  return async (event) => {
    await send({
      TopicArn: process.env.TOPIC_ARN,
      ...failureNotice(event),
    });
    return { statusCode: 200, body: 'ok' };
  };
}

exports.createHandler = createHandler;
exports.handler = async (event) => {
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  const client = new SNSClient({});
  return createHandler((input) => client.send(new PublishCommand(input)))(event);
};
