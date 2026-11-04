// Website, GitHub helper, sync daemon, one-shot tasks, load balancer, and DNS name.
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { Stage } from '../types';
import { stagified } from '../utils';
import { requireEnv, StageConfig } from './config';

export interface AppStackProps extends cdk.StackProps {
  stage: Stage;
  config: StageConfig;
  vpc: ec2.IVpc;
  databaseSecurityGroup: ec2.ISecurityGroup;
  databaseUrl: secretsmanager.ISecret;
  bucket: s3.IBucket;
}

export class AppStack extends cdk.Stack {
  readonly cluster: ecs.Cluster;
  readonly webService: ecs.FargateService;
  readonly daemonService: ecs.FargateService;
  readonly migrateTask: ecs.FargateTaskDefinition;
  readonly mcpService: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly webTargetGroup: elbv2.ApplicationTargetGroup;
  readonly notifyFunction: lambda.Function;
  readonly vectorTask: ecs.FargateTaskDefinition;
  readonly bootstrapTask: ecs.FargateTaskDefinition;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly topic: sns.Topic;
  readonly siteUrl: string;
  readonly logGroupNames: Record<string, string>;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage, config } = props;
    const keep = stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const root = path.join(__dirname, '../..');
    this.siteUrl = `https://${config.webDomainName}`;
    const namespaceName = `${stagified('chapters', stage, false)}.local`;
    const webUrl = `http://web.${namespaceName}:8080`;
    const mcpUrl = `http://github-mcp.${namespaceName}:8082`;

    const signingKey = new secretsmanager.Secret(this, stagified('SigningKey', stage), {
      description: 'Open WebUI session signing key',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
      removalPolicy: keep,
    });
    const oikbApiKey = new secretsmanager.Secret(this, stagified('OikbApiKey', stage), {
      description: 'Password for the oikb daemon API',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
      removalPolicy: keep,
    });
    const openai = plainSecret(this, stagified('OpenaiKey', stage), requireEnv('OPENAI_API_KEY'), 'OpenAI API key', keep);
    const github = plainSecret(this, stagified('GithubToken', stage), requireEnv('GITHUB_TOKEN'), 'GitHub read-only token', keep);
    const adminEmail = plainSecret(this, stagified('AdminEmail', stage), requireEnv('WEBUI_ADMIN_EMAIL'), 'Open WebUI admin email', keep);
    const adminPassword = plainSecret(this, stagified('AdminPassword', stage), requireEnv('WEBUI_ADMIN_PASSWORD'), 'Open WebUI admin password', keep);
    const webuiApiKey = plainSecret(this, stagified('WebuiApiKey', stage), 'pending', 'Open WebUI API key written by bootstrap', keep);
    const knowledgeBaseId = plainSecret(this, stagified('KnowledgeBaseId', stage), 'pending', 'oikb knowledge base id written by bootstrap', keep);

    this.cluster = new ecs.Cluster(this, stagified('Cluster', stage), {
      vpc: props.vpc,
      clusterName: stagified('chapters', stage, false),
    });
    const namespace = new servicediscovery.PrivateDnsNamespace(this, stagified('Namespace', stage), {
      name: namespaceName,
      vpc: props.vpc,
    });

    this.logGroupNames = {
      web: `/chapters/${stage}/web`,
      migrate: `/chapters/${stage}/migrate`,
      mcp: `/chapters/${stage}/mcp`,
      daemon: `/chapters/${stage}/daemon`,
      bootstrap: `/chapters/${stage}/bootstrap`,
      vector: `/chapters/${stage}/vector`,
    };
    const groups = Object.fromEntries(
      Object.entries(this.logGroupNames).map(([name, logGroupName]) => [
        name,
        new logs.LogGroup(this, stagified(`${name}Logs`, stage), {
          logGroupName,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: keep,
        }),
      ]),
    ) as Record<string, logs.LogGroup>;

    const albSg = new ec2.SecurityGroup(this, stagified('AlbSecurityGroup', stage), {
      vpc: props.vpc,
      description: 'Load balancer',
      allowAllOutbound: true,
    });
    for (const cidr of config.allowedIps) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'HTTPS clients');
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'HTTP redirect');
    }

    this.appSecurityGroup = new ec2.SecurityGroup(this, stagified('AppSecurityGroup', stage), {
      vpc: props.vpc,
      description: 'Open WebUI, bootstrap, migration, and the oikb daemon',
      allowAllOutbound: true,
    });
    this.appSecurityGroup.addIngressRule(albSg, ec2.Port.tcp(8080), 'Load balancer to Open WebUI');
    this.appSecurityGroup.addIngressRule(this.appSecurityGroup, ec2.Port.tcp(8080), 'Bootstrap and daemon to Open WebUI');

    const mcpSg = new ec2.SecurityGroup(this, stagified('McpSecurityGroup', stage), {
      vpc: props.vpc,
      description: 'GitHub MCP',
      allowAllOutbound: true,
    });
    mcpSg.addIngressRule(this.appSecurityGroup, ec2.Port.tcp(8082), 'Open WebUI to GitHub MCP');

    new ec2.CfnSecurityGroupIngress(this, stagified('DatabaseIngress', stage), {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.appSecurityGroup.securityGroupId,
      description: 'App tasks to PostgreSQL',
    });

    const webEnv = openWebuiEnvironment(config, props.bucket, 'false');
    const webSecrets = openWebuiSecrets(signingKey, props.databaseUrl, openai, adminEmail, adminPassword);
    const platform: ecs.RuntimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    const webTask = new ecs.FargateTaskDefinition(this, stagified('WebTask', stage), {
      family: stagified('chapters-web', stage, false),
      cpu: 1024,
      memoryLimitMiB: 4096,
      runtimePlatform: platform,
    });
    webTask.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry(config.openWebuiImage),
      environment: webEnv,
      secrets: webSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.web, streamPrefix: 'web' }),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
    });
    props.bucket.grantReadWrite(webTask.taskRole);

    this.webService = new ecs.FargateService(this, stagified('WebService', stage), {
      cluster: this.cluster,
      serviceName: stagified('web', stage, false),
      taskDefinition: webTask,
      desiredCount: 0,
      assignPublicIp: false,
      securityGroups: [this.appSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(600),
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      cloudMapOptions: {
        name: 'web',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        containerPort: 8080,
      },
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, stagified('Alb', stage), {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    this.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');
    const accessLogs = new s3.Bucket(this, stagified('AccessLogs', stage), {
      bucketName: `${config.bucketName}-alb-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: keep,
      autoDeleteObjects: stage !== 'prod',
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
    });
    this.loadBalancer.logAccessLogs(accessLogs, 'alb');
    accessLogs.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [accessLogs.arnForObjects(`alb/AWSLogs/${cdk.Aws.ACCOUNT_ID}/*`)],
    }));
    this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });
    const https = this.loadBalancer.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(config.certificateArn)],
    });
    this.webTargetGroup = https.addTargets('Web', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.webService],
      healthCheck: {
        path: '/health/db',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, stagified('Zone', stage), {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });
    new route53.ARecord(this, stagified('SiteAlias', stage), {
      zone,
      recordName: relativeName(config.webDomainName, config.hostedZoneName),
      target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(this.loadBalancer)),
    });

    const mcpTask = new ecs.FargateTaskDefinition(this, stagified('McpTask', stage), {
      family: stagified('chapters-mcp', stage, false),
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: platform,
    });
    const mcp = mcpTask.addContainer('mcp', {
      image: ecs.ContainerImage.fromRegistry(config.mcpImage),
      command: ['http', '--read-only', '--listen-host', '127.0.0.1', '--port', '8083'],
      environment: { GITHUB_READ_ONLY: '1' },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.mcp, streamPrefix: 'mcp' }),
    });
    const mcpProxyImage = new ecrAssets.DockerImageAsset(this, stagified('McpProxyImage', stage), {
      directory: path.join(root, 'containers', 'mcp-proxy'),
      file: 'Dockerfile',
    });
    const mcpProxy = mcpTask.addContainer('mcp-proxy', {
      image: ecs.ContainerImage.fromDockerImageAsset(mcpProxyImage),
      secrets: {
        GITHUB_PERSONAL_ACCESS_TOKEN: ecs.Secret.fromSecretsManager(github),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.mcp, streamPrefix: 'mcp-proxy' }),
      portMappings: [{ containerPort: 8082, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: [
          'CMD',
          '/nodejs/bin/node',
          '-e',
          "fetch('http://127.0.0.1:8082/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      },
    });
    mcpProxy.addContainerDependencies({
      container: mcp,
      condition: ecs.ContainerDependencyCondition.START,
    });
    this.mcpService = new ecs.FargateService(this, stagified('McpService', stage), {
      cluster: this.cluster,
      serviceName: stagified('mcp', stage, false),
      taskDefinition: mcpTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [mcpSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      cloudMapOptions: {
        name: 'github-mcp',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        container: mcpProxy,
        containerPort: 8082,
      },
    });

    this.migrateTask = new ecs.FargateTaskDefinition(this, stagified('MigrateTask', stage), {
      family: stagified('chapters-migrate', stage, false),
      cpu: 1024,
      memoryLimitMiB: 4096,
      runtimePlatform: platform,
    });
    this.migrateTask.addContainer('migrate', {
      image: ecs.ContainerImage.fromRegistry(config.openWebuiImage),
      entryPoint: ['python'],
      command: ['-c', 'import open_webui.config'],
      environment: openWebuiEnvironment(config, props.bucket, 'true'),
      secrets: webSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.migrate, streamPrefix: 'migrate' }),
    });

    this.vectorTask = new ecs.FargateTaskDefinition(this, stagified('VectorTask', stage), {
      family: stagified('chapters-vector', stage, false),
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: platform,
    });
    this.vectorTask.addContainer('vector', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/postgres:16'),
      entryPoint: ['sh', '-c'],
      command: ['psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector"'],
      secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(props.databaseUrl) },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.vector, streamPrefix: 'vector' }),
    });

    const bootstrapImage = new ecrAssets.DockerImageAsset(this, stagified('BootstrapImage', stage), {
      directory: root,
      file: 'containers/bootstrap/Dockerfile',
      exclude: ['infra/node_modules', 'infra/cdk.out', 'infra/dist', '.git', '.cursor', 'docs', '.env', 'containers/notify-proxy/node_modules', 'containers/sync-metrics/node_modules'],
    });
    this.bootstrapTask = new ecs.FargateTaskDefinition(this, stagified('BootstrapTask', stage), {
      family: stagified('chapters-bootstrap', stage, false),
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: platform,
    });
    this.bootstrapTask.addContainer('bootstrap', {
      image: ecs.ContainerImage.fromDockerImageAsset(bootstrapImage),
      command: ['setup'],
      environment: {
        WEBUI_BASE_URL: webUrl,
        MCP_URL: mcpUrl,
        STAGE: stage,
        BUCKET: props.bucket.bucketName,
        WEBUI_API_KEY_SECRET_ARN: webuiApiKey.secretArn,
        KB_ID_SECRET_ARN: knowledgeBaseId.secretArn,
      },
      secrets: {
        WEBUI_ADMIN_EMAIL: ecs.Secret.fromSecretsManager(adminEmail),
        WEBUI_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword),
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(github),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.bootstrap, streamPrefix: 'bootstrap' }),
    });
    webuiApiKey.grantWrite(this.bootstrapTask.taskRole);
    knowledgeBaseId.grantWrite(this.bootstrapTask.taskRole);
    props.bucket.grantPut(this.bootstrapTask.taskRole, 'reports/*');

    this.topic = new sns.Topic(this, stagified('Alerts', stage), {
      topicName: stagified('chapters-alerts', stage, false),
    });
    this.topic.addSubscription(new subscriptions.EmailSubscription(config.snsEmail));

    this.notifyFunction = new lambda.Function(this, stagified('Notify', stage), {
      functionName: stagified('chapters-oikb-notify', stage, false),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(15),
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/notify')),
      environment: { TOPIC_ARN: this.topic.topicArn },
    });
    this.topic.grantPublish(this.notifyFunction);
    const notifyUrl = this.notifyFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const oikbImage = new ecrAssets.DockerImageAsset(this, stagified('OikbImage', stage), {
      directory: path.join(root, 'containers', 'oikb'),
      file: 'Dockerfile',
      buildArgs: { OIKB_IMAGE: config.oikbImage },
    });
    const daemonTask = new ecs.FargateTaskDefinition(this, stagified('DaemonTask', stage), {
      family: stagified('chapters-daemon', stage, false),
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: platform,
    });
    const notifyProxyImage = new ecrAssets.DockerImageAsset(this, stagified('NotifyProxyImage', stage), {
      directory: path.join(root, 'containers', 'notify-proxy'),
      file: 'Dockerfile',
    });
    const notifyProxy = daemonTask.addContainer('notify-proxy', {
      image: ecs.ContainerImage.fromDockerImageAsset(notifyProxyImage),
      environment: {
        FUNCTION_URL: notifyUrl.url,
        AWS_REGION: 'us-east-1',
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.daemon, streamPrefix: 'notify-proxy' }),
      healthCheck: {
        command: [
          'CMD',
          '/nodejs/bin/node',
          '-e',
          "fetch('http://127.0.0.1:8089/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      },
    });
    const daemon = daemonTask.addContainer('daemon', {
      image: ecs.ContainerImage.fromDockerImageAsset(oikbImage),
      environment: {
        OPEN_WEBUI_URL: webUrl,
        NOTIFY_URL: 'http://127.0.0.1:8089',
      },
      secrets: {
        OPEN_WEBUI_API_KEY: ecs.Secret.fromSecretsManager(webuiApiKey),
        KB_ID: ecs.Secret.fromSecretsManager(knowledgeBaseId),
        OIKB_API_KEY: ecs.Secret.fromSecretsManager(oikbApiKey),
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(github),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.daemon, streamPrefix: 'daemon' }),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
    });
    daemon.addContainerDependencies({
      container: notifyProxy,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });
    const syncMetricsImage = new ecrAssets.DockerImageAsset(this, stagified('SyncMetricsImage', stage), {
      directory: path.join(root, 'containers', 'sync-metrics'),
      file: 'Dockerfile',
    });
    daemonTask.addContainer('sync-metrics', {
      image: ecs.ContainerImage.fromDockerImageAsset(syncMetricsImage),
      environment: {
        STAGE: stage,
        AWS_REGION: 'us-east-1',
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: groups.daemon, streamPrefix: 'sync-metrics' }),
      healthCheck: {
        command: [
          'CMD',
          '/nodejs/bin/node',
          '-e',
          "fetch('http://127.0.0.1:8091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      },
    });
    daemonTask.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'Chapters/Oikb' } },
    }));
    notifyUrl.grantInvokeUrl(daemonTask.taskRole);
    this.daemonService = new ecs.FargateService(this, stagified('DaemonService', stage), {
      cluster: this.cluster,
      serviceName: stagified('daemon', stage, false),
      taskDefinition: daemonTask,
      desiredCount: 0,
      assignPublicIp: false,
      securityGroups: [this.appSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: this.siteUrl });
    cdk.Tags.of(this).add('Service', config.service);
    cdk.Tags.of(this).add('Owner', config.owner);
  }
}

function plainSecret(
  scope: Construct,
  id: string,
  value: string,
  description: string,
  removal: cdk.RemovalPolicy,
): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, id, {
    description,
    secretStringValue: cdk.SecretValue.unsafePlainText(value),
    removalPolicy: removal,
  });
}

function openWebuiEnvironment(config: StageConfig, bucket: s3.IBucket, migrations: string): Record<string, string> {
  return {
    HOST: '0.0.0.0',
    PORT: '8080',
    UVICORN_WORKERS: '1',
    WEBUI_URL: `https://${config.webDomainName}`,
    ENABLE_DB_MIGRATIONS: migrations,
    ENABLE_OLLAMA_API: 'false',
    ENABLE_API_KEYS: 'true',
    VECTOR_DB: 'pgvector',
    PGVECTOR_CREATE_EXTENSION: 'false',
    OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
    RAG_OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
    RAG_EMBEDDING_ENGINE: 'openai',
    RAG_EMBEDDING_MODEL: config.embeddingModel,
    STORAGE_PROVIDER: 's3',
    S3_BUCKET_NAME: bucket.bucketName,
    S3_REGION_NAME: 'us-east-1',
  };
}

function openWebuiSecrets(
  signingKey: secretsmanager.ISecret,
  databaseUrl: secretsmanager.ISecret,
  openai: secretsmanager.ISecret,
  adminEmail: secretsmanager.ISecret,
  adminPassword: secretsmanager.ISecret,
): Record<string, ecs.Secret> {
  const database = ecs.Secret.fromSecretsManager(databaseUrl);
  const openaiSecret = ecs.Secret.fromSecretsManager(openai);
  return {
    WEBUI_SECRET_KEY: ecs.Secret.fromSecretsManager(signingKey),
    DATABASE_URL: database,
    PGVECTOR_DB_URL: database,
    OPENAI_API_KEY: openaiSecret,
    RAG_OPENAI_API_KEY: openaiSecret,
    WEBUI_ADMIN_EMAIL: ecs.Secret.fromSecretsManager(adminEmail),
    WEBUI_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword),
  };
}

function relativeName(domain: string, zoneName: string): string {
  const suffix = `.${zoneName}`;
  if (domain === zoneName) {
    return '';
  }
  if (!domain.endsWith(suffix)) {
    throw new Error(`WEB_DOMAIN_NAME ${domain} is not inside hosted zone ${zoneName}.`);
  }
  return domain.slice(0, -suffix.length);
}
