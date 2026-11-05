// Alarms, plain-language alarm mail, dashboard, monthly budget, and the request rate limit.
// The dashboard reads Chapters/Oikb, which the daemon task publishes.
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
  openWebuiService: ecs.IBaseService;
  oikbDaemonService: ecs.IBaseService;
  githubMcpService: ecs.IBaseService;
  openWebuiTargetGroup: elbv2.IApplicationTargetGroup;
  loadBalancer: elbv2.IApplicationLoadBalancer;
  database: rds.IDatabaseInstance;
  oikbNotifyFunction: lambda.IFunction;
  slackFunction: lambda.IFunction;
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

    const openWebuiMissing = serviceMissing(props.cluster, props.openWebuiService, minute);
    const oikbDaemonMissing = serviceMissing(props.cluster, props.oikbDaemonService, minute);
    const githubMcpMissing = serviceMissing(props.cluster, props.githubMcpService, minute);
    const websiteDown = new cloudwatch.MathExpression({
      expression: 'IF(live >= 1 AND FILL(healthy, 0) < 1, 1, 0)',
      usingMetrics: {
        live: taskCount(props.cluster, props.openWebuiService, 'LiveTaskCount', 'Minimum', minute),
        healthy: props.openWebuiTargetGroup.metrics.healthyHostCount({
          period: minute,
          statistic: 'Minimum',
          label: 'Healthy website tasks',
        }),
      },
      period: minute,
      label: 'Website task is up but failing its health check',
    });
    const daemonSilent = new cloudwatch.MathExpression({
      expression: 'IF(live >= 1 AND FILL(report, 0) < 1, 1, 0)',
      usingMetrics: {
        live: taskCount(props.cluster, props.oikbDaemonService, 'LiveTaskCount', 'Minimum', minute),
        report: oikbMetric(stage, 'SyncReport', 'Sync status was reported', 'Maximum', {}, minute),
      },
      period: minute,
      label: 'Sync daemon is up but not reporting',
    });

    watch(this, stage, mail, 'WebsiteDown', `${stage} website`, websiteDown, 15,
      'The website task is running, but its health check is failing. People cannot use the site. Check the web service logs.');
    watch(this, stage, mail, 'WebsiteTaskMissing', `${stage} website task`, openWebuiMissing, 15,
      'The website has no running task. If setup has not finished, wait for the ready email. If the site was already up, check the web service in ECS.');
    watch(this, stage, mail, 'DaemonTaskMissing', `${stage} sync daemon`, oikbDaemonMissing, 15,
      'The sync daemon has no running task. If setup has not finished, wait for the ready email. If it was already up, the knowledge base may stop updating. Check the daemon service in ECS.');
    watch(this, stage, mail, 'DaemonSilent', `${stage} sync status`, daemonSilent, 5,
      'The sync daemon task is running, but it has not reported its status for five minutes. The knowledge base may stop updating. Check the daemon logs.');
    watch(this, stage, mail, 'GithubHelperDown', `${stage} GitHub helper`, githubMcpMissing, 15,
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
      props.oikbNotifyFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: 'Sync alert errors' }),
      1,
      'The function that emails you about a failed sync is itself failing. You may miss a sync failure. Check the notify function logs.');
    watch(this, stage, mail, 'SlackAlertFailing', `${stage} Slack alert`,
      props.slackFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: 'Slack alert errors' }),
      1,
      'The function that posts alerts to Slack is failing. Email still arrives. Check the Slack function logs.');
    watch(this, stage, mail, 'SyncHung', `${stage} sync hung`,
      new cloudwatch.Metric({
        namespace: 'Chapters/Oikb',
        metricName: 'SyncRunningTooLong',
        dimensionsMap: { Stage: stage },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
        label: 'Sync still running after an hour',
      }),
      2,
      'The sync has been running for more than an hour. A normal sync of this repository finishes sooner. Check the daemon logs.');
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

    const five = cdk.Duration.minutes(5);
    const requests = filled('requests', props.loadBalancer.metrics.requestCount({
      period: five,
      statistic: 'Sum',
    }), 'Requests');
    const answered = filled('answers', props.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_2XX_COUNT, {
      period: five,
      statistic: 'Sum',
    }), 'Answers from the site');
    const rejected = filled('rejected', props.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_4XX_COUNT, {
      period: five,
      statistic: 'Sum',
    }), 'Rejected before the site');
    const siteErrors = new cloudwatch.MathExpression({
      expression: 'FILL(fromSite, 0) + FILL(fromBalancer, 0)',
      usingMetrics: {
        fromSite: props.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: five,
          statistic: 'Sum',
        }),
        fromBalancer: props.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
          period: five,
          statistic: 'Sum',
        }),
      },
      period: five,
      label: 'Site errors',
    });
    const speed = new cloudwatch.MathExpression({
      expression: 'seconds * 1000',
      usingMetrics: {
        seconds: props.loadBalancer.metrics.targetResponseTime({ period: five, statistic: 'Average' }),
      },
      period: five,
      label: 'Milliseconds',
    });
    const freeDiskGb = new cloudwatch.MathExpression({
      expression: 'free / 1024 / 1024 / 1024',
      usingMetrics: {
        free: props.database.metricFreeStorageSpace({ period: five, statistic: 'Average' }),
      },
      period: five,
      label: 'Free disk (GB)',
    });
    const blockedOrZero = filled('blocked', blocked, 'Blocked requests');
    const dashboard = new cloudwatch.Dashboard(this, stagified('Dashboard', stage), {
      dashboardName: stagified('chapters', stage, false),
      defaultInterval: cdk.Duration.hours(3),
      widgets: [[
        number('Healthy website tasks', props.openWebuiTargetGroup.metrics.healthyHostCount({
          period: minute,
          statistic: 'Minimum',
          label: 'Healthy tasks',
        })),
        number('Website tasks', taskCount(props.cluster, props.openWebuiService, 'LiveTaskCount', 'Maximum', minute, 'Website')),
        number('Sync daemon tasks', taskCount(props.cluster, props.oikbDaemonService, 'LiveTaskCount', 'Maximum', minute, 'Sync daemon')),
        number('GitHub helper tasks', taskCount(props.cluster, props.githubMcpService, 'LiveTaskCount', 'Maximum', minute, 'GitHub helper')),
        number('Minutes since last sync', oikbAcross(stage, 'SecondsSinceLastSync', 'MIN', 'Minimum', minute, 'Minutes', 60)),
        number('Next sync in (minutes)', oikbAcross(stage, 'NextSyncInSeconds', 'MIN', 'Minimum', minute, 'Minutes', 60)),
      ], [
        number('Last sync took (seconds)', oikbAcross(stage, 'LastSyncDurationSeconds', 'MAX', 'Maximum', minute, 'Seconds')),
        number('Files added last sync', oikbAcross(stage, 'FilesAdded', 'SUM', 'Maximum', minute, 'Files')),
        number('Files changed last sync', oikbAcross(stage, 'FilesModified', 'SUM', 'Maximum', minute, 'Files')),
        number('Files removed last sync', oikbAcross(stage, 'FilesRemoved', 'SUM', 'Maximum', minute, 'Files')),
        number('Syncs succeeded', oikbStatus(stage, 'success', minute, 'Succeeded')),
        number('Syncs failed', oikbStatus(stage, 'error', minute, 'Failed')),
      ], [
        graph('Requests to the site. One page load is about 200', [requests], { min: 0 }),
        graph('Answers and errors', [answered, rejected, siteErrors], { min: 0 }),
        graph('How long a request took', [speed], { min: 0 }),
      ], [
        graph('Tasks', [
          taskCount(props.cluster, props.openWebuiService, 'LiveTaskCount', 'Average', five, 'Website'),
          taskCount(props.cluster, props.oikbDaemonService, 'LiveTaskCount', 'Average', five, 'Sync daemon'),
          taskCount(props.cluster, props.githubMcpService, 'LiveTaskCount', 'Average', five, 'GitHub helper'),
        ], { min: 0, max: 2 }),
        graph('Database processor', [
          props.database.metricCPUUtilization({ period: five, statistic: 'Average', label: 'CPU (%)' }),
        ], { min: 0, max: 100 }),
        graph('Database connections', [
          props.database.metricDatabaseConnections({ period: five, statistic: 'Maximum', label: 'Connections' }),
        ], { min: 0, max: 100 }),
      ], [
        graph('Database free disk, out of 20 GB', [freeDiskGb], { min: 0, max: 20, label: 'GB free' }),
        graph('Blocked requests. The limit is 2000 per address every five minutes', [blockedOrZero], { min: 0 }),
        graph('Sync still running after an hour', [
          oikbMetric(stage, 'SyncRunningTooLong', 'Over an hour', 'Maximum', {}, five),
        ], { min: 0, max: 1 }),
      ], [
        graph('Syncs finished since this task started', [
          oikbStatus(stage, 'success', five, 'Succeeded'),
          oikbStatus(stage, 'partial', five, 'Partial'),
          oikbStatus(stage, 'error', five, 'Failed'),
        ], { min: 0 }, 12),
        graph('Files uploaded and deleted since this task started', [
          oikbAcross(stage, 'FilesUploadedTotal', 'SUM', 'Maximum', five, 'Uploaded'),
          oikbAcross(stage, 'FilesDeletedTotal', 'SUM', 'Maximum', five, 'Deleted'),
        ], { min: 0 }, 12),
      ], [
        syncHistory(stage),
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
    expression: 'IF(live < 1, 1, 0)',
    usingMetrics: {
      live: taskCount(cluster, service, 'LiveTaskCount', 'Minimum', period),
    },
    period,
    label: 'Task is down',
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
  period = cdk.Duration.minutes(5),
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'Chapters/Oikb',
    metricName,
    dimensionsMap: { Stage: stage, ...dimensions },
    statistic,
    period,
    label,
  });
}

function oikbAcross(
  stage: string,
  metricName: string,
  reduce: 'SUM' | 'MIN' | 'MAX',
  statistic: string,
  period: cdk.Duration,
  label: string,
  scale = 1,
): cloudwatch.MathExpression {
  const search = `SEARCH('{Chapters/Oikb,Source,Stage} MetricName="${metricName}" Stage="${stage}"', '${statistic}', ${period.toSeconds()})`;
  return new cloudwatch.MathExpression({
    expression: scale === 1 ? `${reduce}(${search})` : `${reduce}(${search}) / ${scale}`,
    label,
    period,
  });
}

function oikbStatus(stage: string, status: string, period: cdk.Duration, label: string): cloudwatch.MathExpression {
  return new cloudwatch.MathExpression({
    expression: `SUM(SEARCH('{Chapters/Oikb,Source,Stage,Status} MetricName="SyncsFinished" Stage="${stage}" Status="${status}"', 'Maximum', ${period.toSeconds()}))`,
    label,
    period,
  });
}

function syncHistory(stage: string): cloudwatch.LogQueryWidget {
  return new cloudwatch.LogQueryWidget({
    title: 'Finished syncs',
    width: 24,
    height: 6,
    logGroupNames: [`/chapters/${stage}/daemon`],
    queryLines: [
      'filter @message like /sync-history status=/',
      'parse @message "status=* duration_ms=* added=* modified=* deleted=* error=*" as status, durationMs, added, modified, deleted, error',
      'display @timestamp, status, durationMs, added, modified, deleted, error',
      'sort @timestamp desc',
      'limit 20',
    ],
  });
}

function filled(id: string, metric: cloudwatch.IMetric, label: string): cloudwatch.MathExpression {
  return new cloudwatch.MathExpression({
    expression: `FILL(${id}, 0)`,
    usingMetrics: { [id]: metric },
    label,
    period: cdk.Duration.minutes(5),
  });
}

function number(title: string, metric: cloudwatch.IMetric): cloudwatch.SingleValueWidget {
  return new cloudwatch.SingleValueWidget({
    title,
    width: 4,
    height: 4,
    metrics: [metric],
    sparkline: false,
  });
}

function graph(
  title: string,
  metrics: cloudwatch.IMetric[],
  axis?: cloudwatch.YAxisProps,
  width = 8,
): cloudwatch.GraphWidget {
  return new cloudwatch.GraphWidget({
    title,
    width,
    height: 6,
    left: metrics,
    leftYAxis: axis,
  });
}

function visibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    metricName,
    sampledRequestsEnabled: true,
  };
}
