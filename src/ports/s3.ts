import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

function getContentType(filename: string): string {
  if (filename.endsWith(".mp3")) return "audio/mpeg";
  if (filename.endsWith(".xml")) return "application/rss+xml";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg"))
    return "image/jpeg";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".txt")) return "text/plain";
  if (filename.endsWith(".srt")) return "application/srt";
  return "application/octet-stream";
}

export async function downloadFromR2(
  bucket: string,
  key: string,
): Promise<Uint8Array | null> {
  try {
    const result = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!result.Body) return null;
    return new Uint8Array(await result.Body.transformToByteArray());
  } catch {
    return null;
  }
}

export async function uploadFile(
  filePath: string,
  key: string,
  bucket: string,
  cacheControl?: string,
): Promise<void> {
  const file = Bun.file(filePath);
  const body = await file.arrayBuffer();
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: new Uint8Array(body),
      ContentType: getContentType(key),
      CacheControl: cacheControl,
    }),
  );
}

export async function listRemoteFiles(bucket: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of result.Contents || []) {
      if (obj.Key) keys.add(obj.Key);
    }
    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return keys;
}
