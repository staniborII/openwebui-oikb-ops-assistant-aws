// Turns a CloudWatch alarm into a short email. A return to OK sends a separate recovered message.
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const client = new SNSClient({});

exports.handler = async (event) => {
  const alarm = event.alarmData ?? {};
  const name = alarm.alarmName || 'A monitor fired';
  const state = alarm.state?.value || 'ALARM';
  const description = alarm.configuration?.description || 'A monitored resource needs attention.';
  const when = alarm.state?.timestamp || '';
  const recovered = state === 'OK';
  const subject = `${recovered ? 'Recovered' : 'Action needed'}: ${name}`.slice(0, 100);
  const lines = recovered
    ? [`${name} is healthy again. Nothing needs to be done.`]
    : [description];
  lines.push(`Stage: ${process.env.STAGE || 'unknown'}`);
  if (when) {
    lines.push(`Time: ${when}`);
  }
  await client.send(new PublishCommand({
    TopicArn: process.env.TOPIC_ARN,
    Subject: subject,
    Message: lines.join('\n\n'),
  }));
};
