// Reads the stage yaml and infra/.env, and rejects a stage file that is missing a required setting.
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { Stage } from '../types';

const INFRA = path.resolve(__dirname, '..');

export interface StageConfig {
  service: string;
  name: string;
  owner: string;
  bucketName: string;
  webDomainName: string;
  allowedIps: string[];
  hostedZoneId: string;
  hostedZoneName: string;
  certificateArn: string;
  snsEmail: string;
  embeddingModel: string;
  openWebuiImage: string;
  oikbImage: string;
  githubMcpImage: string;
  monthlyBudgetUsd: number;
}

const REQUIRED = [
  'SERVICE',
  'NAME',
  'OWNER',
  'BUCKET_NAME',
  'WEB_DOMAIN_NAME',
  'ALLOWED_IPS',
  'DOMAIN_HOSTED_ZONE_ID',
  'DOMAIN_HOSTED_ZONE_NAME',
  'CERTIFICATE_ARN',
  'SNS_EMAIL',
  'RAG_EMBEDDING_MODEL',
  'OPEN_WEBUI_IMAGE',
  'OIKB_IMAGE',
  'MCP_IMAGE',
  'MONTHLY_BUDGET_USD',
] as const;

export function loadDotEnv(): void {
  const file = path.join(INFRA, '.env');
  if (!fs.existsSync(file)) {
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Put it in infra/.env or the shell environment. It is not written into the repository.`);
  }
  return value;
}

export function loadStageConfig(stage: Stage): StageConfig {
  const file = path.join(__dirname, '..', `config.${stage}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing stage config ${file}.`);
  }
  const parsed = parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (parsed[key] === undefined || parsed[key] === '') {
      throw new Error(`${path.basename(file)} is missing ${key}.`);
    }
  }
  const allowed = parsed.ALLOWED_IPS;
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some((item) => typeof item !== 'string')) {
    throw new Error(`${path.basename(file)} ALLOWED_IPS must be a list of CIDR strings.`);
  }
  const config: StageConfig = {
    service: String(parsed.SERVICE),
    name: String(parsed.NAME),
    owner: String(parsed.OWNER),
    bucketName: String(parsed.BUCKET_NAME),
    webDomainName: String(parsed.WEB_DOMAIN_NAME),
    allowedIps: allowed.map(String),
    hostedZoneId: String(parsed.DOMAIN_HOSTED_ZONE_ID),
    hostedZoneName: String(parsed.DOMAIN_HOSTED_ZONE_NAME),
    certificateArn: String(parsed.CERTIFICATE_ARN),
    snsEmail: String(parsed.SNS_EMAIL),
    embeddingModel: String(parsed.RAG_EMBEDDING_MODEL),
    openWebuiImage: String(parsed.OPEN_WEBUI_IMAGE),
    oikbImage: String(parsed.OIKB_IMAGE),
    githubMcpImage: String(parsed.MCP_IMAGE),
    monthlyBudgetUsd: Number(parsed.MONTHLY_BUDGET_USD),
  };
  if (!Number.isFinite(config.monthlyBudgetUsd) || config.monthlyBudgetUsd <= 0) {
    throw new Error('MONTHLY_BUDGET_USD must be a positive number of US dollars.');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucketName)) {
    throw new Error(`BUCKET_NAME ${config.bucketName} is not a valid bucket name.`);
  }
  if (!config.webDomainName.includes('.') || config.webDomainName.includes('://')) {
    throw new Error('WEB_DOMAIN_NAME must be a hostname, without a scheme.');
  }
  if (!config.hostedZoneId.startsWith('Z')) {
    throw new Error('DOMAIN_HOSTED_ZONE_ID must be a Route 53 hosted zone id.');
  }
  const certificatePrefix = ['arn', 'aws', 'acm', 'us-east-1', ''].join(':');
  if (!config.certificateArn.startsWith(certificatePrefix)) {
    throw new Error('CERTIFICATE_ARN must be an ACM certificate in us-east-1.');
  }
  if (!config.snsEmail.includes('@')) {
    throw new Error('SNS_EMAIL must be an email address.');
  }
  for (const cidr of config.allowedIps) {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) {
      throw new Error(`ALLOWED_IPS entry ${cidr} must be an IPv4 CIDR.`);
    }
  }
  return config;
}
