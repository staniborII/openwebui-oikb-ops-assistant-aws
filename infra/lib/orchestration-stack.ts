// Setup workflow. Runs the one-shot tasks by family name, then starts the website and the daemon.
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { Stage } from '../types';
import { stagified } from '../utils';
import { StageConfig } from './config';

export interface OrchestrationStackProps extends cdk.StackProps {
  stage: Stage;
  config: StageConfig;
  cluster: ecs.ICluster;
  appSecurityGroup: ec2.ISecurityGroup;
  openWebuiService: ecs.IBaseService;
  oikbDaemonService: ecs.IBaseService;
  pgvectorTask: ecs.TaskDefinition;
  openWebuiMigrateTask: ecs.TaskDefinition;
  bootstrapTask: ecs.TaskDefinition;
  topic: sns.ITopic;
  siteUrl: string;
  logGroupNames: Record<string, string>;
}

export class OrchestrationStack extends cdk.Stack {
  readonly workflow: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const keep = stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const failMail = new tasks.SnsPublish(this, stagified('FailureMail', stage), {
      topic: props.topic,
      subject: `Open WebUI ${stage} setup failed`,
      message: sfn.TaskInput.fromObject({
        stage,
        site: props.siteUrl,
        time: sfn.JsonPath.stringAt('$$.State.EnteredTime'),
        error: sfn.JsonPath.objectAt('$.error'),
        logGroups: props.logGroupNames,
      }),
    });
    const failed = new sfn.Fail(this, stagified('Failed', stage), {
      cause: 'Setup failed. Details are in the failure email and the workflow log.',
    });
    failMail.next(failed);

    const pgvectorFamily = stagified('chapters-vector', stage, false);
    const openWebuiMigrateFamily = stagified('chapters-migrate', stage, false);
    const bootstrapFamily = stagified('chapters-bootstrap', stage, false);
    const pgvectorExtension = runFargate(this, 'CreateVectorExtension', props, latestTask(pgvectorFamily, props.pgvectorTask));
    const openWebuiMigration = runFargate(this, 'MigrateOpenWebui', props, latestTask(openWebuiMigrateFamily, props.openWebuiMigrateTask));
    const bootstrap = runFargate(this, 'Bootstrap', props, latestTask(bootstrapFamily, props.bootstrapTask));
    const startOpenWebui = scale(this, 'StartOpenWebui', props, props.openWebuiService, 1);
    const startOikbDaemon = scale(this, 'StartDaemon', props, props.oikbDaemonService, 1);
    const pause = new sfn.Wait(this, stagified('WaitForWeb', stage), {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });
    const ready = new tasks.SnsPublish(this, stagified('ReadyMail', stage), {
      topic: props.topic,
      subject: `Open WebUI ${stage} is ready`,
      message: sfn.TaskInput.fromText(
        `The ${stage} demo is ready at ${props.siteUrl}. Sign in with the admin email from your .env file.`,
      ),
    });

    for (const step of [pgvectorExtension, openWebuiMigration, startOpenWebui, bootstrap, startOikbDaemon]) {
      step.addCatch(failMail, { resultPath: '$.error' });
    }
    pgvectorExtension.next(openWebuiMigration).next(startOpenWebui).next(pause).next(bootstrap).next(startOikbDaemon).next(ready);

    const flowLogs = new logs.LogGroup(this, stagified('WorkflowLogs', stage), {
      logGroupName: `/chapters/${stage}/workflow`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: keep,
    });
    this.workflow = new sfn.StateMachine(this, stagified('Workflow', stage), {
      stateMachineName: stagified('chapters-bootstrap', stage, false),
      timeout: cdk.Duration.hours(2),
      definitionBody: sfn.DefinitionBody.fromChainable(pgvectorExtension),
      logs: { destination: flowLogs, level: sfn.LogLevel.ERROR },
    });
    this.workflow.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [props.openWebuiService.serviceArn, props.oikbDaemonService.serviceArn],
      }),
    );
    // CDK allows StopTask and DescribeTasks on every task in the account, and
    // PassRole to any service. The denies keep both on this cluster and ECS.
    this.workflow.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['ecs:StopTask', 'ecs:DescribeTasks'],
      resources: ['*'],
      conditions: {
        ArnNotEquals: { 'ecs:cluster': props.cluster.clusterArn },
      },
    }));
    this.workflow.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['iam:PassRole'],
      resources: ['*'],
      conditions: {
        StringNotEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      },
    }));

    const rule = new events.Rule(this, stagified('OnThisStackComplete', stage), {
      ruleName: stagified('chapters-stack-complete', stage, false),
      eventPattern: {
        source: ['aws.cloudformation'],
        detailType: ['CloudFormation Stack Status Change'],
        resources: [cdk.Stack.of(this).stackId],
        detail: {
          'status-details': {
            status: ['CREATE_COMPLETE', 'UPDATE_COMPLETE'],
          },
        },
      },
    });
    rule.addTarget(new targets.SfnStateMachine(this.workflow));

    new cdk.CfnOutput(this, 'SiteUrl', { value: props.siteUrl });
    cdk.Tags.of(this).add('Service', props.config.service);
    cdk.Tags.of(this).add('Owner', props.config.owner);
  }
}

// The run uses the family name, so ECS picks the latest revision. The IAM
// resource is family:*, not the task definition Ref. A Ref includes the
// revision and CloudFormation cannot change that export while this stack
// imports it.
function latestTask(family: string, source: ecs.TaskDefinition): ecs.TaskDefinition {
  const executionRole = source.executionRole;
  if (!executionRole) {
    throw new Error(`Task family ${family} has no execution role.`);
  }
  return {
    family,
    taskDefinitionArn: cdk.Stack.of(source).formatArn({
      service: 'ecs',
      resource: 'task-definition',
      resourceName: `${family}:*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    }),
    taskRole: source.taskRole,
    executionRole,
    networkMode: ecs.NetworkMode.AWS_VPC,
    defaultContainer: source.defaultContainer,
    isFargateCompatible: true,
    findContainer: (name: string) => source.findContainer(name),
  } as ecs.TaskDefinition;
}

function runFargate(
  scope: Construct,
  name: string,
  props: OrchestrationStackProps,
  taskDefinition: ecs.TaskDefinition,
): tasks.EcsRunTask {
  return new tasks.EcsRunTask(scope, stagified(name, props.stage), {
    integrationPattern: sfn.IntegrationPattern.RUN_JOB,
    cluster: props.cluster,
    taskDefinition,
    launchTarget: new tasks.EcsFargateLaunchTarget(),
    assignPublicIp: false,
    securityGroups: [props.appSecurityGroup],
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    propagatedTagSource: ecs.PropagatedTagSource.TASK_DEFINITION,
  });
}

function scale(
  scope: Construct,
  name: string,
  props: OrchestrationStackProps,
  service: ecs.IBaseService,
  desired: number,
): tasks.CallAwsService {
  return new tasks.CallAwsService(scope, stagified(name, props.stage), {
    service: 'ecs',
    action: 'updateService',
    iamResources: [service.serviceArn],
    parameters: {
      Cluster: props.cluster.clusterArn,
      Service: service.serviceName,
      DesiredCount: desired,
    },
  });
}
