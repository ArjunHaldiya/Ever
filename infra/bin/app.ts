import * as cdk from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack";

// One place to change the region. It must match where Bedrock model access is enabled.
const REGION = "us-east-1";

const app = new cdk.App();

new AppStack(app, "AppStack", {
  // Account comes from the CLI profile; the region is pinned so every resource lands together.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description: "Help line: queue-first ingest, worker, dashboard API, gateway host",
});
