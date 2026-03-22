#!/usr/bin/env bun
/**
 * Provision R2 infrastructure for a channel.
 *
 * Usage: bun run scripts/add-channel.ts <channel-key>
 *
 * Creates the R2 bucket and sets up a custom domain via the Cloudflare API.
 * Requires R2_ADMIN_API_TOKEN and R2_ACCOUNT_ID in the environment.
 */

import { getConfig } from "@/config";

const channelKey = process.argv[2];
if (!channelKey) {
  console.error("Usage: bun run scripts/add-channel.ts <channel-key>");
  process.exit(1);
}

const cfToken = process.env.R2_ADMIN_API_TOKEN;
const accountId = process.env.R2_ACCOUNT_ID;
if (!cfToken || !accountId) {
  console.error("R2_ADMIN_API_TOKEN and R2_ACCOUNT_ID must be set in the environment.");
  process.exit(1);
}

const config = getConfig(channelKey);
const bucket = config.storage.bucket;
const domain = new URL(config.storage.publicUrl).hostname;
const headers = {
  Authorization: `Bearer ${cfToken}`,
  "Content-Type": "application/json",
};

// --- Create R2 bucket via Cloudflare API ---

const createResp = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({ name: bucket }),
  },
);

if (createResp.ok) {
  console.log(`✓ Created bucket: ${bucket}`);
} else {
  const body = await createResp.json() as { errors?: { code: number; message: string }[] };
  const alreadyExists = body.errors?.some((e) => e.code === 10004 || e.code === 10006);
  if (alreadyExists) {
    console.log(`✓ Bucket already exists: ${bucket}`);
  } else {
    console.error(`✗ Failed to create bucket: ${createResp.status}`, JSON.stringify(body));
    process.exit(1);
  }
}

// --- Set up custom domain ---

const zoneId = process.env.CLOUDFLARE_ZONE_ID;
if (zoneId) {
  const domainResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ domain, enabled: true, zoneId }),
    },
  );

  if (domainResp.ok) {
    console.log(`✓ Custom domain configured: ${domain}`);
  } else {
    const body = await domainResp.text();
    if (domainResp.status === 409 || body.includes("already")) {
      console.log(`✓ Custom domain already configured: ${domain}`);
    } else {
      console.error(`✗ Failed to set custom domain: ${domainResp.status} ${body}`);
      process.exit(1);
    }
  }
} else {
  console.log(`\nCustom domain requires CLOUDFLARE_ZONE_ID. Set up manually:`);
  console.log(`  Dashboard → R2 → ${bucket} → Settings → Custom Domains → Connect Domain`);
  console.log(`  Domain: ${domain}`);
}
