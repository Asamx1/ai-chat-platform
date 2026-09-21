import * as Minio from "minio";
const url = new URL(process.env.S3_ENDPOINT || "http://localhost:9000");
const client = new Minio.Client({
  endPoint: url.hostname, port: Number(url.port || 9000), useSSL: url.protocol === "https:",
  accessKey: process.env.MINIO_ROOT_USER || "minioadmin",
  secretKey: process.env.MINIO_ROOT_PASSWORD || "minioadmin",
});
const bucket = process.env.S3_BUCKET || "ai-chat-platform";
const exists = await client.bucketExists(bucket).catch(() => false);
if (!exists) { await client.makeBucket(bucket); console.log("bucket created:", bucket); }
else console.log("bucket exists:", bucket);
process.exit(0);
