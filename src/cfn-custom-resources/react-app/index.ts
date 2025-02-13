// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execSync } from "child_process";
import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import s3SpaUpload from "s3-spa-upload";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { ncp } from "ncp";
import { sendCfnResponse, Status } from "./cfn-response";

interface Configuration {
  BucketName: string;
  ClientId: string;
  CognitoAuthDomain: string;
  RedirectPathSignIn: string;
  RedirectPathSignOut: string;
  UserPoolArn: string;
  OAuthScopes: string;
  SignOutUrl: string;
}

async function buildSpa(config: Configuration) {
  const temp_dir = "/tmp/spa";
  const home_dir = "/tmp/home";

  console.log(
    `Copying SPA sources to ${temp_dir} and making dependencies available there ...`
  );

  [temp_dir, home_dir].forEach((dir) => {
    if (!existsSync(dir)) {
      mkdirSync(dir);
    }
  });

  await Promise.all(
    ["src", "public", "package.json", "package-lock.json"].map(
      async (path) =>
        new Promise<void>((resolve, reject) => {
          ncp(`${__dirname}/react-app/${path}`, `${temp_dir}/${path}`, (err) =>
            err ? reject(err) : resolve()
          );
        })
    )
  );

  const userPoolId = config.UserPoolArn.split("/")[1];
  const userPoolRegion = config.UserPoolArn.split(":")[3];

  console.log(`Creating environment file ${temp_dir}/.env ...`);
  writeFileSync(
    `${temp_dir}/.env`,
    `SKIP_PREFLIGHT_CHECK=true
REACT_APP_USER_POOL_ID=${userPoolId}
REACT_APP_USER_POOL_REGION=${userPoolRegion}
REACT_APP_USER_POOL_WEB_CLIENT_ID=${config.ClientId}
REACT_APP_USER_POOL_AUTH_DOMAIN=${config.CognitoAuthDomain}
REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_IN=${config.RedirectPathSignIn}
REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_OUT=${config.RedirectPathSignOut}
REACT_APP_SIGN_OUT_URL=${config.SignOutUrl}
REACT_APP_USER_POOL_SCOPES=${config.OAuthScopes}
INLINE_RUNTIME_CHUNK=false
`
  );

  console.log(`Installing dependencies to build React app in ${temp_dir} ...`);
  execSync("npm ci", {
    cwd: temp_dir,
    stdio: "inherit",
    env: { ...process.env, HOME: home_dir },
  });
  console.log(`Running build of React app in ${temp_dir} ...`);
  execSync("npm run build", {
    cwd: temp_dir,
    stdio: "inherit",
    env: { ...process.env, HOME: home_dir },
  });
  console.log("Build succeeded");

  return `${temp_dir}/build`;
}

async function buildUploadSpa(
  action: "Create" | "Update" | "Delete",
  config: Configuration,
  physicalResourceId?: string
) {
  if (action === "Create" || action === "Update") {
    const buildDir = await buildSpa(config);
    await s3SpaUpload(buildDir, config.BucketName);
  } else {
    // "Trick" to empty the bucket is to upload an empty dir
    mkdirSync("/tmp/empty_directory", { recursive: true });
    await s3SpaUpload("/tmp/empty_directory", config.BucketName, {
      delete: true,
    });
  }
  return physicalResourceId || "ReactApp";
}

export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context
) => {
  console.log(JSON.stringify(event, undefined, 4));

  const { ResourceProperties, RequestType } = event;

  const { ServiceToken, ...config } = ResourceProperties;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    physicalResourceId = await Promise.race([
      buildUploadSpa(RequestType, config as Configuration, PhysicalResourceId),
      new Promise<undefined>((_, reject) =>
        setTimeout(
          () => reject(new Error("Task timeout")),
          context.getRemainingTimeInMillis() - 500
        )
      ),
    ]);
  } catch (err) {
    console.error(err);
    status = Status.FAILED;
    reason = `${err}`;
  }
  await sendCfnResponse({
    event,
    status,
    data,
    physicalResourceId,
    reason,
  });
};
