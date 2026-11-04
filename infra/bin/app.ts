#!/usr/bin/env node
// CDK app. Loads one stage file and creates Network, Data, App, Orchestration, then Monitoring.
import * as cdk from 'aws-cdk-lib';
import { loadDotEnv, loadStageConfig } from '../lib/config';
import { AppStack } from '../lib/app-stack';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';
import { Stage } from '../types';
import { stagified } from '../utils';

loadDotEnv();

const app = new cdk.App();
const stage = asStage(app.node.tryGetContext('stage') ?? 'dev');
const config = loadStageConfig(stage);
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: 'us-east-1',
};

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
data.addStackDependency(network);

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
application.addStackDependency(data);

const orchestration = new OrchestrationStack(app, stagified('ChaptersOrchestration', stage), {
  stackName: stagified('chapters-orchestration', stage, false),
  env,
  stage,
  config,
  cluster: application.cluster,
  appSecurityGroup: application.appSecurityGroup,
  webService: application.webService,
  daemonService: application.daemonService,
  vectorTask: application.vectorTask,
  migrateTask: application.migrateTask,
  bootstrapTask: application.bootstrapTask,
  topic: application.topic,
  siteUrl: application.siteUrl,
  logGroupNames: application.logGroupNames,
});
orchestration.addStackDependency(application);

const monitoring = new MonitoringStack(app, stagified('ChaptersMonitoring', stage), {
  stackName: stagified('chapters-monitoring', stage, false),
  env,
  stage,
  config,
  topic: application.topic,
  cluster: application.cluster,
  webService: application.webService,
  daemonService: application.daemonService,
  mcpService: application.mcpService,
  webTargetGroup: application.webTargetGroup,
  loadBalancer: application.loadBalancer,
  database: data.database,
  notifyFunction: application.notifyFunction,
  workflow: orchestration.workflow,
});
monitoring.addStackDependency(orchestration);

function asStage(value: unknown): Stage {
  if (value === 'dev' || value === 'staging' || value === 'prod') {
    return value;
  }
  throw new Error(`Stage must be dev, staging, or prod. Received ${String(value)}.`);
}
