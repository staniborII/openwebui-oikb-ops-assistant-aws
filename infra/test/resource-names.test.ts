import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';
import { loadStageConfig } from '../lib/config';
import { Stage } from '../types';
import { stagified } from '../utils';

process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GITHUB_TOKEN = 'test-github-token';
process.env.WEBUI_ADMIN_EMAIL = 'admin@example.com';
process.env.WEBUI_ADMIN_PASSWORD = 'test-password';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/placeholder';
process.env.ENABLE_SIGNUP = 'true';
process.env.DEFAULT_USER_ROLE = 'user';

const DEV_SECRET_IDS = [
  'AdminEmailDev2B8186B4',
  'AdminPasswordDev599EFABA',
  'GithubTokenDevF32B0986',
  'KnowledgeBaseIdDev6E1A6745',
  'OikbApiKeyDev2B7D33E2',
  'OpenaiKeyDevF896D87B',
  'SigningKeyDevD1BABF8A',
  'SlackWebhookDev50CF8B59',
  'WebuiApiKeyDevFA520D79',
];

const DATA_SECRET_IDS = [
  'ChaptersDataDevDatabaseDevSecret91CB9F983fdaad7efa858a3daf9490cf0a702aeb',
  'DatabaseUrlDevC936A38C',
];

function contextForAccount(account: string): Record<string, unknown> {
  const file = path.join(__dirname, '../cdk.context.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const zones = saved[`availability-zones:account=${account}:region=us-east-1`];
  if (!Array.isArray(zones)) {
    throw new Error(`cdk.context.json has no us-east-1 availability zones for account ${account}.`);
  }
  return saved;
}

function assemble(stage: Stage): { data: Template; application: Template; orchestration: Template } {
  const config = loadStageConfig(stage);
  const account = '863518416406';
  const app = new cdk.App({ context: contextForAccount(account) });
  const env = { account, region: 'us-east-1' };
  const network = new NetworkStack(app, stagified('ChaptersNetwork', stage), {
    stackName: stagified('chapters-network', stage, false),
    env,
    stage,
    config,
  });
  const data = new DataStack(app, stagified('ChaptersData', stage), {
    stackName: stagified('chapters-data', stage, false),
    env,
    stage,
    config,
    vpc: network.vpc,
  });
  const application = new AppStack(app, stagified('ChaptersApp', stage), {
    stackName: stagified('chapters-app', stage, false),
    env,
    stage,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: data.databaseSecurityGroup,
    databaseUrl: data.databaseUrl,
    bucket: data.bucket,
  });
  const orchestration = new OrchestrationStack(app, stagified('ChaptersOrchestration', stage), {
    stackName: stagified('chapters-orchestration', stage, false),
    env,
    stage,
    config,
    cluster: application.cluster,
    appSecurityGroup: application.appSecurityGroup,
    openWebuiService: application.openWebuiService,
    oikbDaemonService: application.oikbDaemonService,
    pgvectorTask: application.pgvectorTask,
    openWebuiMigrateTask: application.openWebuiMigrateTask,
    bootstrapTask: application.bootstrapTask,
    topic: application.topic,
    siteUrl: application.siteUrl,
    logGroupNames: application.logGroupNames,
  });
  return {
    data: Template.fromStack(data),
    application: Template.fromStack(application),
    orchestration: Template.fromStack(orchestration),
  };
}

function idsOf(template: Template, type: string): string[] {
  return Object.keys(template.findResources(type)).sort();
}

test('dev database, bucket, and secret identities stay fixed', () => {
  const { data, application } = assemble('dev');

  assert.deepEqual(idsOf(data, 'AWS::RDS::DBInstance'), ['DatabaseDevDEE1F90E']);
  data.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceIdentifier: 'chapters-postgres-dev',
  });

  assert.deepEqual(idsOf(data, 'AWS::S3::Bucket'), ['FilesDev5583F609']);
  data.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'chapters-openwebui-dev' });

  assert.deepEqual(idsOf(application, 'AWS::S3::Bucket'), ['AccessLogsDev67D01E28']);
  application.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'chapters-openwebui-dev-alb-logs',
  });

  assert.deepEqual(idsOf(data, 'AWS::SecretsManager::Secret'), DATA_SECRET_IDS);
  assert.deepEqual(idsOf(application, 'AWS::SecretsManager::Secret'), DEV_SECRET_IDS);
});

test('dev tasks and roles stay least privilege', () => {
  const { data, application, orchestration } = assemble('dev');

  const migrate = taskSecrets(application, 'chapters-migrate-dev');
  assert.deepEqual(migrate, ['DATABASE_URL', 'PGVECTOR_DB_URL', 'WEBUI_SECRET_KEY']);
  assert.ok(taskSecrets(application, 'chapters-web-dev').includes('OPENAI_API_KEY'));
  assert.ok(taskSecrets(application, 'chapters-web-dev').includes('WEBUI_ADMIN_PASSWORD'));
  const webEnv = taskEnvironment(application, 'chapters-web-dev');
  assert.equal(webEnv.CORS_ALLOW_ORIGIN, 'https://dev-client-openwebui.flexxytech.com');
  assert.equal(webEnv.CORS_ALLOW_ORIGIN, webEnv.WEBUI_URL);
  assert.equal(taskEnvironment(application, 'chapters-migrate-dev').CORS_ALLOW_ORIGIN, webEnv.CORS_ALLOW_ORIGIN);

  const dataActions = policyActions(data);
  assert.ok(dataActions.includes('secretsmanager:PutSecretValue'));
  assert.equal(dataActions.includes('secretsmanager:UpdateSecret'), false);

  const appActions = policyActions(application);
  assert.ok(appActions.includes('secretsmanager:PutSecretValue'));
  assert.equal(appActions.includes('secretsmanager:UpdateSecret'), false);
  assert.equal(JSON.stringify(application.findResources('AWS::S3::BucketPolicy')).includes('logdelivery.elasticloadbalancing.amazonaws.com'), false);

  const denies = policyStatements(orchestration).filter((statement) => statement.Effect === 'Deny');
  const denied = denies.flatMap((statement) => [statement.Action].flat());
  assert.ok(denied.includes('ecs:StopTask'));
  assert.ok(denied.includes('ecs:DescribeTasks'));
  assert.ok(denied.includes('iam:PassRole'));
  const clusterDeny = denies.find((statement) => [statement.Action].flat().includes('ecs:StopTask'));
  const passDeny = denies.find((statement) => [statement.Action].flat().includes('iam:PassRole'));
  assert.ok(JSON.stringify(clusterDeny?.Condition).includes('ecs:cluster'));
  assert.ok(JSON.stringify(passDeny?.Condition).includes('ecs-tasks.amazonaws.com'));
});

type PolicyStatement = {
  Effect?: string;
  Action?: string | string[];
  Condition?: unknown;
};

function policyStatements(template: Template): PolicyStatement[] {
  const found: PolicyStatement[] = [];
  for (const resource of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const statement = (resource as { Properties?: { PolicyDocument?: { Statement?: PolicyStatement | PolicyStatement[] } } }).Properties?.PolicyDocument?.Statement;
    if (Array.isArray(statement)) {
      found.push(...statement);
    } else if (statement) {
      found.push(statement);
    }
  }
  return found;
}

function policyActions(template: Template): string[] {
  return policyStatements(template).flatMap((statement) => [statement.Action].flat()).filter((action): action is string => typeof action === 'string');
}

function taskEnvironment(template: Template, family: string): Record<string, string> {
  const task = Object.values(template.findResources('AWS::ECS::TaskDefinition')).find((resource) => {
    return (resource as { Properties?: { Family?: string } }).Properties?.Family === family;
  }) as { Properties?: { ContainerDefinitions?: Array<{ Environment?: Array<{ Name?: string; Value?: string }> }> } } | undefined;
  const values: Record<string, string> = {};
  for (const container of task?.Properties?.ContainerDefinitions ?? []) {
    for (const variable of container.Environment ?? []) {
      if (variable.Name && variable.Value) {
        values[variable.Name] = variable.Value;
      }
    }
  }
  return values;
}

function taskSecrets(template: Template, family: string): string[] {
  const task = Object.values(template.findResources('AWS::ECS::TaskDefinition')).find((resource) => {
    return (resource as { Properties?: { Family?: string } }).Properties?.Family === family;
  }) as { Properties?: { ContainerDefinitions?: Array<{ Secrets?: Array<{ Name?: string }> }> } } | undefined;
  return (task?.Properties?.ContainerDefinitions ?? [])
    .flatMap((container) => container.Secrets ?? [])
    .map((secret) => secret.Name)
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

test('prod keeps its own database and bucket names', () => {
  const { data, application } = assemble('prod');
  data.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceIdentifier: 'chapters-postgres-prod',
  });
  data.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'chapters-openwebui-prod' });
  application.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'chapters-openwebui-prod-alb-logs',
  });
  application.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'chapters-oikb-notify-prod',
  });
  application.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'chapters-slack-prod',
  });
});
