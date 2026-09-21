import { Client } from 'minio';

function storage() {
  const { S3_ENDPOINT, S3_BUCKET, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) throw new Error('STORAGE_UNAVAILABLE');
  const url = new URL(S3_ENDPOINT);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('STORAGE_UNAVAILABLE');
  }
  return {
    bucket: S3_BUCKET,
    client: new Client({ endPoint: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      useSSL: url.protocol === 'https:', accessKey: MINIO_ROOT_USER, secretKey: MINIO_ROOT_PASSWORD }),
  };
}

// Existing bucket must be provisioned private. No ACL changes or public/presigned URLs.
export async function put(key: string, data: Buffer, mime: string): Promise<void> {
  try {
    const { client, bucket } = storage();
    await client.putObject(bucket, key, data, data.byteLength, { 'Content-Type': mime });
  } catch { throw new Error('STORAGE_UNAVAILABLE'); }
}

export async function get(key: string) {
  try {
    const { client, bucket } = storage();
    return await client.getObject(bucket, key);
  } catch { throw new Error('STORAGE_UNAVAILABLE'); }
}

export async function remove(key: string): Promise<void> {
  try {
    const { client, bucket } = storage();
    await client.removeObject(bucket, key);
  } catch { throw new Error('STORAGE_UNAVAILABLE'); }
}

export async function* list(prefix = ''): AsyncGenerator<{ key: string; lastModified: Date }> {
  try {
    const { client, bucket } = storage();
    for await (const item of client.listObjectsV2(bucket, prefix, true)) {
      if (typeof item.name === 'string' && item.lastModified instanceof Date) {
        yield { key: item.name, lastModified: item.lastModified };
      }
    }
  } catch { throw new Error('STORAGE_UNAVAILABLE'); }
}
