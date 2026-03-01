import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { ObjectStore } from "./types";

function getContentType(filename: string): string {
  if (filename.endsWith(".mp3")) return "audio/mpeg";
  if (filename.endsWith(".xml")) return "application/rss+xml";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".txt")) return "text/plain";
  if (filename.endsWith(".srt")) return "text/srt";
  return "application/octet-stream";
}

export function createS3Storage(): ObjectStore {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  return {
    async uploadFile(data, key, bucket, cacheControl) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: getContentType(key),
          CacheControl: cacheControl,
        }),
      );
    },

    async getFile(bucket, key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) return null;
        return new Uint8Array(await result.Body.transformToByteArray());
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "NoSuchKey") return null;
        throw err;
      }
    },
  };
}
