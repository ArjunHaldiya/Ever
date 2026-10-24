import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Duration, RemovalPolicy, SecretValue } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as location from "aws-cdk-lib/aws-location";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const entry = (rel: string) => `${REPO_ROOT}${rel}`;

const NODE_VERSION = "22.11.0";
// Literal names (not secret.secretName, which CDK derives by parsing the ARN).
const PHOTON_SECRET = "app/photon";
const SALT_SECRET = "app/phone-hash-salt";
const API_KEY_SECRET = "app/api-key";
const WORKER_TIMEOUT = Duration.seconds(30);

/**
 * Everything the help line needs in AWS. Hackathon posture: single stack, on-demand
 * capacity, and tables/queues are DESTROYed with the stack (no retained data).
 *
 * Message flow: gateway (EC2) -> inbound SQS -> worker Lambda -> outbound SQS -> gateway.
 * Keeping Photon only on the always-on gateway means no Lambda ever needs to hold a
 * Photon connection, and replies are durable if the gateway restarts.
 */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tablePrefix: string = this.node.tryGetContext("tablePrefix") ?? "app-";
    const aiModeParam: string = this.node.tryGetContext("aiModeParam") ?? "/app/ai_mode";
    // Empty until Bedrock access is confirmed; the worker stays on the rules extractor while empty.
    const bedrockModelId: string =
      this.node.tryGetContext("bedrockModelId") || process.env.BEDROCK_MODEL_ID || "";

    // ---- Queues -------------------------------------------------------------
    const inboundDlq = new sqs.Queue(this, "InboundDlq", {
      queueName: "app-inbound-dlq",
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const inbound = new sqs.Queue(this, "Inbound", {
      queueName: "app-inbound",
      // >= 6x the worker timeout, as recommended for Lambda event sources.
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: inboundDlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });
    const outboundDlq = new sqs.Queue(this, "OutboundDlq", {
      queueName: "app-outbound-dlq",
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const outbound = new sqs.Queue(this, "Outbound", {
      queueName: "app-outbound",
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: outboundDlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ---- Tables (on-demand) -------------------------------------------------
    const table = (
      name: string,
      pk: string,
      opts: { sk?: string; ttl?: boolean } = {},
    ): dynamodb.Table =>
      new dynamodb.Table(this, name, {
        tableName: `${tablePrefix}${name}`,
        partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
        sortKey: opts.sk ? { name: opts.sk, type: dynamodb.AttributeType.STRING } : undefined,
        timeToLiveAttribute: opts.ttl ? "ttl" : undefined,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const resources = table("Resources", "id");
    const needs = table("Needs", "id");
    const residents = table("Residents", "phoneHash");
    // Look up opted-in residents by ZIP when a shutoff is triggered (FR-11).
    residents.addGlobalSecondaryIndex({
      indexName: "zip-index",
      partitionKey: { name: "zip", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const alerts = table("Alerts", "alertId", { sk: "phoneHash" });
    const conversations = table("Conversations", "phoneHash", { ttl: true });
    const processed = table("Processed", "messageId", { ttl: true });
    const allTables = [resources, needs, residents, alerts, conversations, processed];

    // ---- Chaos flag ---------------------------------------------------------
    const aiMode = new ssm.StringParameter(this, "AiMode", {
      parameterName: aiModeParam,
      stringValue: "primary",
      description: "primary | degraded. Flipped by the dashboard chaos toggle.",
    });

    // ---- Secrets ------------------------------------------------------------
    // Photon values are filled in by hand after deploy (never in the template):
    //   aws secretsmanager put-secret-value --secret-id app/photon --secret-string file://photon.json
    const photonSecret = new secrets.Secret(this, "PhotonSecret", {
      secretName: PHOTON_SECRET,
      description: "Spectrum (Photon) credentials. Fill in after deploy.",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({
          SPECTRUM_PROJECT_ID: "",
          SPECTRUM_PROJECT_SECRET: "",
          SPECTRUM_WEBHOOK_SECRET: "",
        }),
      ),
    });
    // Generated once. Rotating it changes every stored phone hash, so never rotate.
    const saltSecret = new secrets.Secret(this, "PhoneHashSalt", {
      secretName: SALT_SECRET,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const apiKeySecret = new secrets.Secret(this, "ApiKey", {
      secretName: API_KEY_SECRET,
      description: "Shared secret for dashboard write routes (x-api-key header).",
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    // ---- Geocoding ----------------------------------------------------------
    const placeIndex = new location.CfnPlaceIndex(this, "Places", {
      indexName: "app-places",
      dataSource: "Esri",
      dataSourceConfiguration: { intendedUse: "SingleUse" },
    });

    // ---- Worker Lambda ------------------------------------------------------
    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
      bundling: { sourceMap: true, target: "node22" },
    };
    // Region is injected by Lambda itself (AWS_REGION is reserved). Secret *names* only: handlers fetch values.
    const sharedEnv = {
      TABLE_PREFIX: tablePrefix,
      AI_MODE_PARAM: aiModeParam,
      QUEUE_URL: inbound.queueUrl,
      DLQ_URL: inboundDlq.queueUrl,
      OUTBOUND_QUEUE_URL: outbound.queueUrl,
      OUTBOUND_DLQ_URL: outboundDlq.queueUrl,
      PHONE_HASH_SALT_SECRET: SALT_SECRET,
      DEMO_MODE: "true",
    };

    const worker = new NodejsFunction(this, "Worker", {
      ...lambdaDefaults,
      entry: entry("packages/worker/src/handler.ts"),
      handler: "handler",
      memorySize: 512,
      timeout: WORKER_TIMEOUT,
      logGroup: new logs.LogGroup(this, "WorkerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        ...sharedEnv,
        BEDROCK_MODEL_ID: bedrockModelId,
        LOCATION_PLACE_INDEX: placeIndex.indexName,
      },
    });
    // Batch size 1 per CLAUDE.md. maxConcurrency keeps a burst from exhausting a new
    // account's Lambda concurrency and burning receive counts on throttles.
    worker.addEventSource(new SqsEventSource(inbound, { batchSize: 1, maxConcurrency: 5 }));
    allTables.forEach((t) => t.grantReadWriteData(worker));
    outbound.grantSendMessages(worker);
    aiMode.grantRead(worker);
    saltSecret.grantRead(worker);
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:Converse"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["geo:SearchPlaceIndexForText"],
        resources: [placeIndex.attrArn],
      }),
    );

    // ---- Dashboard API ------------------------------------------------------
    const apiFn = new NodejsFunction(this, "Api", {
      ...lambdaDefaults,
      entry: entry("packages/api/src/handler.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: { ...sharedEnv, API_KEY_SECRET: API_KEY_SECRET },
    });
    allTables.forEach((t) => t.grantReadWriteData(apiFn));
    outbound.grantSendMessages(apiFn);
    aiMode.grantRead(apiFn);
    aiMode.grantWrite(apiFn);
    apiKeySecret.grantRead(apiFn);
    saltSecret.grantRead(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:GetQueueAttributes"],
        resources: [inbound, inboundDlq, outbound, outboundDlq].map((q) => q.queueArn),
      }),
    );

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: "app-api",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type", "x-api-key"],
      },
    });
    const integration = new HttpLambdaIntegration("ApiIntegration", apiFn);
    httpApi.addRoutes({ path: "/state", methods: [apigw.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/chaos", methods: [apigw.HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/shutoff", methods: [apigw.HttpMethod.POST], integration });

    // ---- Gateway host (always-on; see CLAUDE.md "why the gateway is not a Lambda") ----
    const artifacts = new s3.Bucket(this, "GatewayArtifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Public subnets only, no NAT gateway: the instance needs outbound internet for Photon.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    const gatewaySg = new ec2.SecurityGroup(this, "GatewaySg", {
      vpc,
      description: "Gateway: outbound only. Shell access is via SSM Session Manager, not SSH.",
      allowAllOutbound: true,
    });
    const gatewayRole = new iam.Role(this, "GatewayRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    inbound.grantSendMessages(gatewayRole);
    outbound.grantConsumeMessages(gatewayRole);
    processed.grantReadWriteData(gatewayRole);
    alerts.grantReadWriteData(gatewayRole); // read receipts update deliveredAt / readAt
    photonSecret.grantRead(gatewayRole);
    artifacts.grantRead(gatewayRole);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y tar xz",
      `curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz`,
      "mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1",
      "ln -sf /opt/node/bin/node /usr/local/bin/node",
      "id ever >/dev/null 2>&1 || useradd --system --home-dir /opt/ever ever",
      "mkdir -p /opt/ever /etc/ever && chown ever:ever /opt/ever",
      // Non-secret config only. Photon credentials are read from Secrets Manager at startup.
      "cat > /etc/ever/gateway.env <<'ENVEOF'",
      `AWS_REGION=${this.region}`,
      `QUEUE_URL=${inbound.queueUrl}`,
      `OUTBOUND_QUEUE_URL=${outbound.queueUrl}`,
      `TABLE_PREFIX=${tablePrefix}`,
      `PHOTON_SECRET=${PHOTON_SECRET}`,
      `PHONE_HASH_SALT_SECRET=${SALT_SECRET}`,
      "ENVEOF",
      "cat > /etc/systemd/system/ever-gateway.service <<'UNITEOF'",
      "[Unit]",
      "Description=Gateway (message ingest and send)",
      "After=network-online.target",
      "Wants=network-online.target",
      "ConditionPathExists=/opt/ever/gateway.mjs",
      "[Service]",
      "User=ever",
      "EnvironmentFile=/etc/ever/gateway.env",
      "ExecStart=/usr/local/bin/node /opt/ever/gateway.mjs",
      "Restart=always",
      "RestartSec=3",
      "[Install]",
      "WantedBy=multi-user.target",
      "UNITEOF",
      // Run via SSM send-command after uploading gateway.mjs to the artifacts bucket.
      "cat > /usr/local/bin/ever-gateway-update <<'UPDEOF'",
      "#!/bin/bash",
      "set -euo pipefail",
      `aws s3 cp s3://${artifacts.bucketName}/gateway.mjs /opt/ever/gateway.mjs.new`,
      "mv /opt/ever/gateway.mjs.new /opt/ever/gateway.mjs",
      "systemctl daemon-reload",
      "systemctl enable ever-gateway",
      "systemctl restart ever-gateway",
      "UPDEOF",
      "chmod +x /usr/local/bin/ever-gateway-update",
      "systemctl daemon-reload",
    );

    const gateway = new ec2.Instance(this, "Gateway", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: gatewaySg,
      role: gatewayRole,
      userData,
      associatePublicIpAddress: true,
      requireImdsv2: true,
    });

    // ---- Outputs (feed .env.local and the deploy scripts) --------------------
    const out = (name: string, value: string) => new CfnOutput(this, name, { value });
    out("QueueUrl", inbound.queueUrl);
    out("DlqUrl", inboundDlq.queueUrl);
    out("OutboundQueueUrl", outbound.queueUrl);
    out("OutboundDlqUrl", outboundDlq.queueUrl);
    out("TablePrefix", tablePrefix);
    out("AiModeParam", aiMode.parameterName);
    out("LocationPlaceIndex", placeIndex.indexName);
    out("ApiUrl", httpApi.apiEndpoint);
    out("ApiKeySecretName", API_KEY_SECRET);
    out("PhotonSecretName", PHOTON_SECRET);
    out("GatewayInstanceId", gateway.instanceId);
    out("GatewayArtifactsBucket", artifacts.bucketName);
  }
}
