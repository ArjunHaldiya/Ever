import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack";

let template: Template;

beforeAll(() => {
  // Empty list = skip esbuild bundling; these tests only inspect the template.
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new AppStack(app, "TestStack", { env: { region: "us-west-2", account: "111111111111" } });
  template = Template.fromStack(stack);
});

describe("queues (FR-10, zero message loss)", () => {
  it("redrives the inbound queue to a DLQ after 3 receives", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "app-inbound",
      RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() },
    });
    template.hasResourceProperties("AWS::SQS::Queue", { QueueName: "app-inbound-dlq" });
  });

  it("redrives the outbound queue too, so replies are never silently lost", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "app-outbound",
      RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() },
    });
  });

  it("triggers the worker one message at a time", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 5 },
    });
  });

  it("gives the inbound queue a visibility timeout of at least 6x the worker timeout", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "app-inbound",
      VisibilityTimeout: 180,
    });
    template.hasResourceProperties("AWS::Lambda::Function", { Timeout: 30, MemorySize: 512 });
  });
});

describe("data model", () => {
  it.each(["Resources", "Needs", "Residents", "Alerts", "Conversations", "Processed"])(
    "creates an on-demand %s table with the prefixed name",
    (name) => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: `app-${name}`,
        BillingMode: "PAY_PER_REQUEST",
      });
    },
  );

  it("keys Alerts by alertId + phoneHash and Residents by phoneHash", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "app-Alerts",
      KeySchema: [
        { AttributeName: "alertId", KeyType: "HASH" },
        { AttributeName: "phoneHash", KeyType: "RANGE" },
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "app-Residents",
      KeySchema: [{ AttributeName: "phoneHash", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "zip-index" })],
    });
  });

  it.each(["Processed", "Conversations"])("expires %s rows via TTL", (name) => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: `app-${name}`,
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });
});

describe("chaos flag", () => {
  it("creates /app/ai_mode defaulting to primary", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/app/ai_mode",
      Value: "primary",
    });
  });
});

describe("secrets and privacy", () => {
  it("leaves Photon credentials blank in the template", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "app/photon",
      SecretString: JSON.stringify({
        SPECTRUM_PROJECT_ID: "",
        SPECTRUM_PROJECT_SECRET: "",
        SPECTRUM_WEBHOOK_SECRET: "",
      }),
    });
  });

  it("generates the phone-hash salt and API key instead of hardcoding them", () => {
    for (const Name of ["app/phone-hash-salt", "app/api-key"]) {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Name,
        GenerateSecretString: Match.objectLike({ PasswordLength: Match.anyValue() }),
      });
    }
  });

  it("passes secret names, never secret values, to Lambdas", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(fns)) {
      const env = JSON.stringify(fn.Properties?.Environment ?? {});
      expect(env).not.toMatch(/SECRET_VALUE|resolve:secretsmanager/);
    }
  });

  it("does not set the reserved AWS_REGION variable on Lambdas", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(fns)) {
      expect(fn.Properties?.Environment?.Variables ?? {}).not.toHaveProperty("AWS_REGION");
    }
  });
});

describe("worker permissions", () => {
  it("can use Bedrock, Comprehend PII detection, and the place index", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("bedrock:InvokeModel");
    expect(policies).toContain("comprehend:DetectPiiEntities");
    expect(policies).toContain("geo:SearchPlaceIndexForText");
  });

  it("creates the place index", () => {
    template.hasResourceProperties("AWS::Location::PlaceIndex", { IndexName: "app-places" });
  });
});

describe("gateway host", () => {
  it("is a t3.small that requires IMDSv2", () => {
    template.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t3.small" });
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: Match.objectLike({ HttpTokens: "required" }),
      }),
    });
  });

  it("opens no inbound ports (shell access is SSM only)", () => {
    const sgs = template.findResources("AWS::EC2::SecurityGroup");
    for (const sg of Object.values(sgs)) {
      expect(sg.Properties?.SecurityGroupIngress).toBeUndefined();
    }
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
  });

  it("uses no NAT gateway", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("keeps the artifacts bucket private", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe("dashboard API", () => {
  it("exposes only the three dashboard routes", () => {
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => r.Properties?.RouteKey,
    );
    expect(routes.sort()).toEqual(["GET /state", "POST /chaos", "POST /shutoff"]);
  });
});
