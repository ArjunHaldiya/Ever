import * as cdk from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack";

const app = new cdk.App();

new AppStack(app, "AppStack", {
  // Region is fixed (Bedrock/Location/Comprehend availability); account comes from the CLI profile.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-west-2" },
  description: "Help line: queue-first ingest, worker, dashboard API, gateway host",
});
