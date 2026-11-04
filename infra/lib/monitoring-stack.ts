// Alarms, plain-language alarm mail, dashboard, monthly budget, and the request rate limit.
// Sync graphs read Chapters/Oikb, which the daemon task publishes.
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Stage } from '../types';
import { stagified } from '../utils';
import { StageConfig } from './config';

export interface MonitoringStackProps extends cdk.StackProps {
  stage: Stage;
  config: StageConfig;
  topic: sns.ITopic;
  cluster: ecs.ICluster;
  webService: ecs.IBaseService;
  daemonService: ecs.IBaseService;
  mcpService: ecs.IBaseService;
  webTargetGroup: elbv2.IApplicationTargetGroup;
  loadBalancer: elbv2.IApplicationLoadBalancer;
  database: rds.IDatabaseInstance;
  notifyFunction: lambda.IFunction;
  workflow: sfn.IStateMachine;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { stage, config } = props;
    const keep = stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const minute = cdk.Duration.minutes(1);

    const mailLogs = new logs.LogGroup(this, stagified('AlarmMailLogs', stage), {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: keep,
    });
    const mailer = new lambda.Function(this, stagified('AlarmMail', stage), {
      functionName: stagified('chapters-alarm-mail', stage, false),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(15),
      logGroup: mailLogs,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/alarm-mail')),
      environment: {
        TOPIC_ARN: props.topic.topicArn,
        STAGE: stage,
      },
    });
    props.topic.grantPublish(mailer);
    const mail = new actions.LambdaAction(mailer, { useUniquePermissionId: true });

    const webMissing = serviceMissing(props.cluster, props.webService, minute);
    const daemonMissing = serviceMissing(props.cluster, props.daemonService, minute);
    const mcpMissing = serviceMissing(props.cluster, props.mcpService, minute);
    const websiteDown = new cloudwatch.MathExpression({
      expression: 'IF(desired > 0 AND running >= desired AND healthy < 1, 1, 0)',
      usingMetrics: {
        desired: taskCount(props.cluster, props.webService, 'DesiredTaskCount', 'Maximum', minute),
        running: taskCount(props.cluster, props.webService, 'RunningTaskCount', 'Minimum', minute),
        healthy: props.webTargetGroup.metrics.healthyHostCount({
          period: minute,
          statistic: 'Sum',
          label: 'Healthy website tasks',
        }),
      },
      period: minute,
      label: 'Website is up but failing its health check',
    });

    watch(this, stage, mail, 'WebsiteDown', `${stage} website`, websiteDown, 15,
      'The website is supposed to be running, but its health check is failing. People cannot use the site. Check the web service logs.');
    watch(this, stage, mail, 'WebsiteTaskMissing', `${stage} website task`, webMissing, 15,
      'The website is supposed to have a task, and that task is not running. Check the web service in ECS.');
    watch(this, stage, mail, 'DaemonTaskMissing', `${stage} sync daemon`, daemonMissing, 15,
      'The sync daemon is supposed to be running, and its task is not. The knowledge base may stop updating. Check the daemon service in ECS.');
    watch(this, stage, mail, 'GithubHelperDown', `${stage} GitHub helper`, mcpMissing, 15,
      'The private GitHub helper should always have one task. Questions that need a live look at GitHub will fail. Check the MCP service in ECS.');
    watch(this, stage, mail, 'DatabaseDiskLow', `${stage} database disk`,
      props.database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5), statistic: 'Minimum', label: 'Free disk (bytes)' }),
      1,
      'Less than 2 GB is free on the 20 GB database disk. The site can stop saving chats. Free space in the database, or plan a larger disk.',
      2 * 1024 * 1024 * 1024,
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    watch(this, stage, mail, 'DatabaseBusy', `${stage} database processor`,
      props.database.metricCPUUtilization({ period: cdk.Duration.minutes(5), statistic: 'Average', label: 'Database CPU (%)' }),
      3,
      'The database processor has stayed above 80 percent. The site may feel slow.',
      80);
    watch(this, stage, mail, 'DatabaseConnections', `${stage} database connections`,
      props.database.metricDatabaseConnections({ period: cdk.Duration.minutes(5), statistic: 'Maximum', label: 'Database connections' }),
      2,
      'More than 80 connections are open. This small database starts refusing new ones well before 100, and the site will fail to load.',
      80);
    watch(this, stage, mail, 'SyncAlertFailing', `${stage} sync alert`,
      props.notifyFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: 'Sync alert errors' }),
      1,
      'The function that emails you about a failed sync is itself failing. You may miss a sync failure. Check the notify function logs.');
    watch(this, stage, mail, 'SetupFailed', `${stage} setup`,
      props.workflow.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: 'Failed setups' }),
      1,
      'The setup workflow failed. A separate email from that workflow has the reason. The daemon stays off until setup succeeds.');

    const aclName = stagified('chapters-waf', stage, false);
    const acl = new wafv2.CfnWebACL(this, stagified('WebAcl', stage), {
      name: aclName,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(aclName),
      customResponseBodies: {
        TooManyRequests: {
          contentType: 'TEXT_PLAIN',
          content: 'Too many requests from your address. Wait a few minutes and try again.',
        },
      },
      rules: [{
        name: 'LimitEachAddress',
        priority: 1,
        action: {
          block: {
            customResponse: {
              responseCode: 429,
              customResponseBodyKey: 'TooManyRequests',
            },
          },
        },
        statement: {
          rateBasedStatement: {
            limit: 2000,
            aggregateKeyType: 'IP',
          },
        },
        visibilityConfig: visibility('LimitEachAddress'),
      }],
    });
    new wafv2.CfnWebACLAssociation(this, stagified('WebAclAssociation', stage), {
      resourceArn: props.loadBalancer.loadBalancerArn,
      webAclArn: acl.attrArn,
    });
    const blocked = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: aclName, Region: 'us-east-1', Rule: 'ALL' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      label: 'Blocked requests',
    });
    watch(this, stage, mail, 'RequestsBlocked', `${stage} request flood`, blocked, 1,
      'The site blocked a burst of requests. One address is limited to 2000 requests every five minutes. If this was a visitor, they can try again shortly. If it continues, someone is flooding the site.',
      100);

    const visitors = props.loadBalancer.metrics.requestCount({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'Requests',
    });
    const siteErrors = props.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'Site errors',
    });
    const speed = props.loadBalancer.metrics.targetResponseTime({
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
      label: 'Response time (seconds)',
    });
    const freeDiskGb = new cloudwatch.MathExpression({
      expression: 'free / 1024 / 1024 / 1024',
      usingMetrics: {
        free: props.database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
      },
      period: cdk.Duration.minutes(5),
      label: 'Free disk (GB)',
    });
    const dashboard = new cloudwatch.Dashboard(this, stagified('Dashboard', stage), {
      dashboardName: stagified('chapters', stage, false),
      widgets: [[
        graph('Visitors', visitors),
        graph('Site errors', siteErrors),
        graph('How long requests take', speed),
      ], [
        graph(
          'Tasks running',
          taskCount(props.cluster, props.webService, 'RunningTaskCount', 'Average', cdk.Duration.minutes(5), 'Website'),
          taskCount(props.cluster, props.daemonService, 'RunningTaskCount', 'Average', cdk.Duration.minutes(5), 'Sync daemon'),
          taskCount(props.cluster, props.mcpService, 'RunningTaskCount', 'Average', cdk.Duration.minutes(5), 'GitHub helper'),
        ),
        graph('Database processor', props.database.metricCPUUtilization({ period: cdk.Duration.minutes(5), statistic: 'Average', label: 'CPU (%)' })),
        graph('Database connections', props.database.metricDatabaseConnections({ period: cdk.Duration.minutes(5), statistic: 'Maximum', label: 'Connections' })),
      ], [
        graph('Database free disk', freeDiskGb),
        graph('Blocked requests', blocked),
      ], [
        graph(
          'Syncs',
          oikbMetric(stage, 'Syncs', 'Succeeded', 'Sum', { Status: 'success' }),
          oikbMetric(stage, 'Syncs', 'Partial', 'Sum', { Status: 'partial' }),
          oikbMetric(stage, 'Syncs', 'Failed', 'Sum', { Status: 'error' }),
        ),
        graph(
          'Files synced',
          oikbMetric(stage, 'FilesUploaded', 'Uploaded', 'Sum'),
          oikbMetric(stage, 'FilesDeleted', 'Deleted', 'Sum'),
        ),
        graph('Sync duration', oikbMetric(stage, 'SyncDurationSeconds', 'Longest sync (seconds)', 'Maximum')),
      ]],
    });

    new budgets.CfnBudget(this, stagified('MonthlyBudget', stage), {
      budget: {
        budgetName: stagified('chapters-monthly-cost', stage, false),
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:Service$${config.service}`] },
      },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: {
          comparisonOperator: 'GREATER_THAN',
          notificationType: 'ACTUAL',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ address: config.snsEmail, subscriptionType: 'EMAIL' }],
      })),
    });

    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });
    cdk.Tags.of(this).add('Service', config.service);
    cdk.Tags.of(this).add('Owner', config.owner);
  }
}

function watch(
  scope: Construct,
  stage: Stage,
  mail: actions.LambdaAction,
  id: string,
  alarmName: string,
  metric: cloudwatch.IMetric,
  evaluationPeriods: number,
  description: string,
  threshold = 1,
  comparison = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, stagified(id, stage), {
    alarmName,
    alarmDescription: description,
    metric,
    threshold,
    comparisonOperator: comparison,
    evaluationPeriods,
    datapointsToAlarm: evaluationPeriods,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(mail);
  alarm.addOkAction(mail);
  return alarm;
}

function serviceMissing(cluster: ecs.ICluster, service: ecs.IBaseService, period: cdk.Duration): cloudwatch.MathExpression {
  return new cloudwatch.MathExpression({
    expression: 'IF(desired > 0 AND running < desired, 1, 0)',
    usingMetrics: {
      desired: taskCount(cluster, service, 'DesiredTaskCount', 'Maximum', period),
      running: taskCount(cluster, service, 'RunningTaskCount', 'Minimum', period),
    },
    period,
    label: 'Missing tasks',
  });
}

function taskCount(
  cluster: ecs.ICluster,
  service: ecs.IBaseService,
  metricName: string,
  statistic: string,
  period: cdk.Duration,
  label = metricName,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'AWS/ECS',
    metricName,
    dimensionsMap: {
      ClusterName: cluster.clusterName,
      ServiceName: service.serviceName,
    },
    statistic,
    period,
    label,
  });
}

function oikbMetric(
  stage: string,
  metricName: string,
  label: string,
  statistic: string,
  dimensions: Record<string, string> = {},
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'Chapters/Oikb',
    metricName,
    dimensionsMap: { Stage: stage, ...dimensions },
    statistic,
    period: cdk.Duration.minutes(5),
    label,
  });
}

function graph(title: string, ...metrics: cloudwatch.IMetric[]): cloudwatch.GraphWidget {
  return new cloudwatch.GraphWidget({
    title,
    width: 8,
    height: 6,
    left: metrics,
  });
}

function visibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    metricName,
    sampledRequestsEnabled: true,
  };
}
