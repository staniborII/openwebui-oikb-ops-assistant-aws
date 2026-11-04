// VPC in two availability zones: public, private, and isolated subnets, with one NAT gateway.
// S3 from the private subnets uses a gateway endpoint. The NAT stays for everything else.
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { Stage } from '../types';
import { stagified } from '../utils';
import { StageConfig } from './config';

export interface NetworkStackProps extends cdk.StackProps {
  stage: Stage;
  config: StageConfig;
}

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const cidrs: Record<Stage, string> = {
      dev: '10.20.0.0/16',
      staging: '10.40.0.0/16',
      prod: '10.30.0.0/16',
    };
    this.vpc = new ec2.Vpc(this, stagified('Vpc', props.stage), {
      ipAddresses: ec2.IpAddresses.cidr(cidrs[props.stage]),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpc.addGatewayEndpoint(stagified('S3Endpoint', props.stage), {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });
    cdk.Tags.of(this).add('Service', props.config.service);
    cdk.Tags.of(this).add('Owner', props.config.owner);
  }
}
