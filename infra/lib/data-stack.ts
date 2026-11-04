// PostgreSQL, the file bucket, and the secret that holds the database URL.
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Stage } from '../types';
import { removalPolicy, stagified } from '../utils';
import { StageConfig } from './config';

export interface DataStackProps extends cdk.StackProps {
  stage: Stage;
  config: StageConfig;
  vpc: ec2.IVpc;
}

export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly databaseUrl: secretsmanager.Secret;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const keep = removalPolicy(props.stage) === 'retain' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, stagified('DatabaseSecurityGroup', props.stage), {
      vpc: props.vpc,
      description: 'PostgreSQL. Ingress is added by the App stack.',
      allowAllOutbound: true,
    });

    this.database = new rds.DatabaseInstance(this, stagified('Database', props.stage), {
      instanceIdentifier: stagified('chapters-postgres', props.stage, false),
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      databaseName: 'openwebui',
      credentials: rds.Credentials.fromGeneratedSecret('openwebui'),
      backupRetention: cdk.Duration.days(props.stage === 'prod' ? 7 : 1),
      deletionProtection: props.stage === 'prod',
      removalPolicy: keep,
      deleteAutomatedBackups: props.stage !== 'prod',
    });

    if (!this.database.secret) {
      throw new Error('RDS did not generate a master secret.');
    }

    this.databaseUrl = new secretsmanager.Secret(this, stagified('DatabaseUrl', props.stage), {
      description: 'PostgreSQL URL for Open WebUI and pgvector',
      secretStringValue: cdk.SecretValue.unsafePlainText('pending'),
      removalPolicy: keep,
    });

    const writer = new lambda.Function(this, stagified('DatabaseUrlWriter', props.stage), {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(1),
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/database-url')),
    });
    this.database.secret.grantRead(writer);
    this.databaseUrl.grantWrite(writer);

    const provider = new cr.Provider(this, stagified('DatabaseUrlProvider', props.stage), {
      onEventHandler: writer,
    });
    const writeUrl = new cdk.CustomResource(this, stagified('DatabaseUrlWrite', props.stage), {
      serviceToken: provider.serviceToken,
      properties: {
        SecretArn: this.database.secret.secretArn,
        TargetSecretArn: this.databaseUrl.secretArn,
        Host: this.database.dbInstanceEndpointAddress,
        Port: this.database.dbInstanceEndpointPort,
        Database: 'openwebui',
      },
    });
    writeUrl.node.addDependency(this.database);

    this.bucket = new s3.Bucket(this, stagified('Files', props.stage), {
      bucketName: props.config.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: keep,
      autoDeleteObjects: props.stage !== 'prod',
    });

    cdk.Tags.of(this).add('Service', props.config.service);
    cdk.Tags.of(this).add('Owner', props.config.owner);
  }
}
