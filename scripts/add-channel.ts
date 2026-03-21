#!/usr/bin/env bun
/**
 * Provision R2 infrastructure for a channel.
 *
 * Usage: bun run scripts/add-channel.ts <channel-key>
 *
 * Creates the R2 bucket (idempotent) and optionally sets up a custom domain
 * if CLOUDFLARE_API_TOKEN is available.
 */

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { getConfig } from "@/config";

const channelKey = process.argv[2];
if (!channelKey) {
  console.error("Usage: bun run scripts/add-channel.ts <channel-key>");
  process.exit(1);
}

const config = getConfig(channelKey);
const bucket = config.storage.bucket;
const domain = new URL(config.storage.publicUrl).hostname;

// --- Create R2 bucket via S3 API ---

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`✓ Created bucket: ${bucket}`);
} catch (err: unknown) {
  if (
    err instanceof Error &&
    (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists")
  ) {
    console.log(`✓ Bucket already exists: ${bucket}`);
  } else {
    throw err;
  }
}

// --- Set up custom domain via Cloudflare API ---

const cfToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.R2_ACCOUNT_ID;

if (cfToken && accountId) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/custom_domains`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ domain }),
  });

  if (resp.ok) {
    console.log(`✓ Custom domain configured: ${domain}`);
  } else {
    const body = await resp.text();
    // Domain may already be configured
    if (resp.status === 409 || body.includes("already")) {
      console.log(`✓ Custom domain already configured: ${domain}`);
    } else {
      console.error(`✗ Failed to set custom domain: ${resp.status} ${body}`);
      process.exit(1);
    }
  }
} else {
  console.log(`\nTo set up the custom domain, either:`);
  console.log(`  • Set CLOUDFLARE_API_TOKEN in .env and re-run this script`);
  console.log(`  • Or configure manually in Cloudflare dashboard:`);
  console.log(`    Bucket: ${bucket}`);
  console.log(`    Domain: ${domain}`);
}
