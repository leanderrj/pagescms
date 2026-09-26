import { env } from "cloudflare:workers";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { projectStorageConfigTable } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { getCachedConfig } from "@/lib/config-store";
import { checkEnvRefsPresent, collectEnvRefs, resolveEnvRef } from "@/lib/env-ref";

export type StorageVisibility = "public" | "private";

export type StorageConfig = {
  source: "d1" | "env" | "config";
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  prefix: string;
  visibility: StorageVisibility;
  thresholdBytes: number;
  maxFileBytes: number; // -1 disables
  publicBaseUrl: string | null;
};

export type ConfigStorageBlock = {
  provider?: "r2" | "s3";
  bucket?: string;
  accountId?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicUrl?: string;
  prefix?: string;
  visibility?: StorageVisibility;
  forcePathStyle?: boolean;
  thresholdBytes?: number;
  maxFileBytes?: number;
};

export const findStorageBlockInConfig = (configObject: any): ConfigStorageBlock | null => {
  const media = configObject?.media;
  if (!media) return null;
  if (Array.isArray(media)) {
    for (const item of media) {
      if (item?.storage) return item.storage as ConfigStorageBlock;
    }
    return null;
  }
  if (typeof media === "object" && media.storage) {
    return media.storage as ConfigStorageBlock;
  }
  return null;
};

export const collectEnvVarRefs = (block: ConfigStorageBlock | null | undefined): string[] =>
  block ? collectEnvRefs(Object.values(block)) : [];

export const checkEnvVarsPresent = checkEnvRefsPresent;

const configStorageFromObject = (configObject: any): StorageConfig | null => {
  const block = findStorageBlockInConfig(configObject);
  if (!block) return null;
  const accessKey = resolveEnvRef(block.accessKeyId, "credential");
  const secretKey = resolveEnvRef(block.secretAccessKey, "credential");
  const bucket = resolveEnvRef(block.bucket);
  if (!accessKey || !secretKey || !bucket) return null;

  let endpoint = resolveEnvRef(block.endpoint);
  if (!endpoint && block.provider === "r2") {
    const accountId = resolveEnvRef(block.accountId);
    if (!accountId) return null;
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (!endpoint) return null;

  return {
    source: "config",
    endpoint,
    region: resolveEnvRef(block.region) || "auto",
    bucket,
    accessKey,
    secretKey,
    forcePathStyle: block.forcePathStyle ?? true,
    prefix: resolveEnvRef(block.prefix) || "",
    visibility: block.visibility ?? "public",
    thresholdBytes: block.thresholdBytes ?? 26214400,
    maxFileBytes: block.maxFileBytes ?? -1,
    publicBaseUrl: resolveEnvRef(block.publicUrl) || null,
  };
};

const envConfig = (): StorageConfig | null => {
  const e = env as unknown as Record<string, string | undefined>;
  const accessKey = e.PAGES_S3_ACCESS_KEY ?? "";
  const secretKey = e.PAGES_S3_SECRET_KEY ?? "";
  if (!accessKey || !secretKey) return null;
  return {
    source: "env",
    endpoint: e.PAGES_S3_ENDPOINT ?? "http://minio:6557",
    region: e.PAGES_S3_REGION ?? "us-east-1",
    bucket: e.PAGES_S3_BUCKET ?? "pagescms-media",
    accessKey,
    secretKey,
    forcePathStyle: true,
    prefix: "",
    visibility: (e.PAGES_S3_VISIBILITY as StorageVisibility) ?? "public",
    thresholdBytes: parseInt(e.PAGES_S3_THRESHOLD ?? "26214400", 10),
    maxFileBytes: parseInt(e.PAGES_S3_MAX_FILE_BYTES ?? "-1", 10),
    publicBaseUrl: e.PAGES_S3_PUBLIC_BASE_URL ?? null,
  };
};

const projectConfig = async (
  owner: string,
  repo: string,
  branch?: string,
): Promise<StorageConfig | null> => {
  const lowerOwner = owner.toLowerCase();
  const lowerRepo = repo.toLowerCase();

  const branchRow = branch
    ? await db.query.projectStorageConfigTable.findFirst({
        where: and(
          sql`lower(${projectStorageConfigTable.owner}) = ${lowerOwner}`,
          sql`lower(${projectStorageConfigTable.repo}) = ${lowerRepo}`,
          eq(projectStorageConfigTable.branch, branch),
        ),
      })
    : undefined;

  const row = branchRow ?? await db.query.projectStorageConfigTable.findFirst({
    where: and(
      sql`lower(${projectStorageConfigTable.owner}) = ${lowerOwner}`,
      sql`lower(${projectStorageConfigTable.repo}) = ${lowerRepo}`,
      eq(projectStorageConfigTable.branch, ""),
    ),
  });

  if (!row) return null;

  const accessKey = await decrypt(row.accessKeyCiphertext, row.accessKeyIv);
  const secretKey = await decrypt(row.secretKeyCiphertext, row.secretKeyIv);
  if (!accessKey || !secretKey) return null;

  return {
    source: "d1",
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKey,
    secretKey,
    forcePathStyle: !!row.forcePathStyle,
    prefix: row.prefix ?? "",
    visibility: (row.visibility as StorageVisibility) ?? "public",
    thresholdBytes: row.thresholdBytes,
    maxFileBytes: row.maxFileBytes,
    publicBaseUrl: row.publicBaseUrl,
  };
};

export const getStorageConfig = async (
  owner: string,
  repo: string,
  branch?: string,
): Promise<StorageConfig | null> => {
  const fromProject = await projectConfig(owner, repo, branch);
  if (fromProject) return fromProject;

  if (branch) {
    try {
      const cached = await getCachedConfig(owner, repo, branch);
      const fromConfig = configStorageFromObject(cached?.object);
      if (fromConfig) return fromConfig;
    } catch {
      // best-effort; fall back to env
    }
  }

  return envConfig();
};

export async function isStorageConfigured(
  owner: string,
  repo: string,
  branch?: string,
): Promise<boolean> {
  return !!(await getStorageConfig(owner, repo, branch));
}

const buildClient = (cfg: StorageConfig): S3Client =>
  new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: cfg.forcePathStyle,
  });

export function s3Key(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  prefix = "",
): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const cleanPath = path.replace(/^\//, "");
  const head = cleanPrefix ? `${cleanPrefix}/` : "";
  return `${head}${owner}/${repo}/${branch}/${cleanPath}`;
}

export function s3PublicUrl(baseUrl: string, key: string, cdnBaseUrl?: string | null): string {
  if (cdnBaseUrl) return `${cdnBaseUrl.replace(/\/$/, "")}/${key}`;
  return `${baseUrl.replace(/\/$/, "")}/api/s3/${key}`;
}

const mimeFromKey = (key: string): string => {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    avif: "image/avif", heic: "image/heic",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    pdf: "application/pdf", json: "application/json",
    txt: "text/plain", md: "text/markdown",
  };
  return map[ext] ?? "application/octet-stream";
};

export async function s3Upload(
  cfg: StorageConfig,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ key: string; size: number }> {
  const client = buildClient(cfg);
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: body.length,
  }));
  return { key, size: body.length };
}

export async function s3Delete(cfg: StorageConfig, key: string): Promise<void> {
  const client = buildClient(cfg);
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

export async function s3Head(
  cfg: StorageConfig,
  key: string,
): Promise<{ size: number; contentType?: string } | null> {
  try {
    const client = buildClient(cfg);
    const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch {
    return null;
  }
}

export async function s3Get(
  cfg: StorageConfig,
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string; size: number } | null> {
  try {
    const client = buildClient(cfg);
    const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const arrayBuffer = await res.Body!.transformToByteArray();
    return {
      body: arrayBuffer.buffer.slice(
        arrayBuffer.byteOffset,
        arrayBuffer.byteOffset + arrayBuffer.byteLength,
      ) as ArrayBuffer,
      contentType: res.ContentType ?? mimeFromKey(key),
      size: arrayBuffer.byteLength,
    };
  } catch {
    return null;
  }
}

export async function s3List(
  cfg: StorageConfig,
  prefix: string,
  continuationToken?: string,
): Promise<{ keys: { key: string; size: number; lastModified?: Date }[]; next?: string }> {
  const client = buildClient(cfg);
  const res = await client.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: prefix,
    ContinuationToken: continuationToken,
    MaxKeys: 1000,
  }));
  return {
    keys: (res.Contents ?? []).map((o) => ({
      key: o.Key!,
      size: o.Size ?? 0,
      lastModified: o.LastModified,
    })),
    next: res.IsTruncated ? res.NextContinuationToken : undefined,
  };
}

export async function s3PresignedPut(
  cfg: StorageConfig,
  key: string,
  contentType: string,
  expiresInSeconds = 600,
): Promise<string> {
  const client = buildClient(cfg);
  return getSignedUrl(client, new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: contentType,
  }), { expiresIn: expiresInSeconds });
}

export async function s3PresignedGet(
  cfg: StorageConfig,
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  const client = buildClient(cfg);
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
  }), { expiresIn: expiresInSeconds });
}

export async function s3CreateMultipart(
  cfg: StorageConfig,
  key: string,
  contentType: string,
): Promise<string> {
  const client = buildClient(cfg);
  const res = await client.send(new CreateMultipartUploadCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: contentType,
  }));
  if (!res.UploadId) throw new Error("Failed to create multipart upload.");
  return res.UploadId;
}

export async function s3PresignedPart(
  cfg: StorageConfig,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds = 1800,
): Promise<string> {
  const client = buildClient(cfg);
  return getSignedUrl(client, new UploadPartCommand({
    Bucket: cfg.bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  }), { expiresIn: expiresInSeconds });
}

export async function s3CompleteMultipart(
  cfg: StorageConfig,
  key: string,
  uploadId: string,
  parts: { ETag: string; PartNumber: number }[],
): Promise<void> {
  const client = buildClient(cfg);
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: cfg.bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));
}

export async function s3AbortMultipart(
  cfg: StorageConfig,
  key: string,
  uploadId: string,
): Promise<void> {
  const client = buildClient(cfg);
  await client.send(new AbortMultipartUploadCommand({
    Bucket: cfg.bucket,
    Key: key,
    UploadId: uploadId,
  }));
}

// Encrypt-and-store helper used by the settings UI when a user sets credentials.
export async function encryptStorageCreds(accessKey: string, secretKey: string) {
  const a = await encrypt(accessKey);
  const s = await encrypt(secretKey);
  return {
    accessKeyCiphertext: a.ciphertext,
    accessKeyIv: a.iv,
    secretKeyCiphertext: s.ciphertext,
    secretKeyIv: s.iv,
  };
}
