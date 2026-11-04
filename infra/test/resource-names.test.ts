import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';
import { loadStageConfig } from '../lib/config';
import { Stage } from '../types';
import { stagified } from '../utils';

process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GITHUB_TOKEN = 'test-github-token';
process.env.WEBUI_ADMIN_EMAIL = 'admin@example.com';
process.env.WEBUI_ADMIN_PASSWORD = 'test-password';

const DEV_SECRET_IDS = [
  'AdminEmailDev2B8186B4',
  'AdminPasswordDev599EFABA',
  'GithubTokenDevF32B0986',
  'KnowledgeBaseIdDev6E1A6745',
  'OikbApiKeyDev2B7D33E2',
  'OpenaiKeyDevF896D87B',
  'SigningKeyDevD1BABF8A',
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

function assemble(stage: Stage): { data: Template; application: Template } {
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
  return {
    data: Template.fromStack(data),
    application: Template.fromStack(application),
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
});
