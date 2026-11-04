// CDK custom resource. Copies the RDS master secret into a PostgreSQL URL secret. The URL is not returned.
const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

exports.handler = async (event) => {
  const target = event.ResourceProperties.TargetSecretArn;
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: target };
  }
  const client = new SecretsManagerClient({});
  const got = await client.send(new GetSecretValueCommand({ SecretId: event.ResourceProperties.SecretArn }));
  const parsed = JSON.parse(got.SecretString);
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  const host = event.ResourceProperties.Host;
  const port = event.ResourceProperties.Port;
  const database = event.ResourceProperties.Database;
  const url = 'postgresql://' + user + ':' + pass + '@' + host + ':' + port + '/' + database + '?sslmode=require';
  await client.send(new PutSecretValueCommand({ SecretId: target, SecretString: url }));
  return { PhysicalResourceId: target, Data: { Ready: 'true' } };
};
