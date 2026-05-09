// R2/S3-compat storage wrapper para criativos.
// Usa @aws-sdk/client-s3 com endpoint customizado (funciona em Cloudflare R2,
// MinIO, etc). Upload via buffer; URL pública opcional.

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { constants as fsConstants } from "fs";
import fs from "fs/promises";
import path from "path";

const endpoint = process.env.R2_ENDPOINT || "";
const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
const bucket = process.env.R2_BUCKET || "agente-criativos";
const publicBase = process.env.R2_PUBLIC_URL || "";
const localUploadsRoot = process.env.LOCAL_UPLOADS_DIR || path.resolve(process.cwd(), "var/uploads");
const backendPublicBase =
  (process.env.BACKEND_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, "");

let client: S3Client | null = null;

export type StorageMode = "r2" | "local";

function getClient(): S3Client {
  if (!client) {
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("R2 storage não configurado (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
    }
    client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

export function getStorageMode(): StorageMode {
  return endpoint && accessKeyId && secretAccessKey ? "r2" : "local";
}

export function isStorageConfigured(): boolean {
  // R2 configurado OU storage local é acessível
  return (!!endpoint && !!accessKeyId && !!secretAccessKey) || getStorageMode() === "local";
}

export function getLocalUploadsRoot(): string {
  return localUploadsRoot;
}

function encodeStorageKey(key: string): string {
  return key
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

export function getPublicAssetUrl(key: string): string {
  return getStorageMode() === "r2"
    ? publicBase
      ? `${publicBase.replace(/\/$/, "")}/${key}`
      : `${backendPublicBase}/uploads/${encodeStorageKey(key)}`
    : `${backendPublicBase}/uploads/${encodeStorageKey(key)}`;
}

export function resolveStoredFilePath(key: string): string | null {
  if (getStorageMode() !== "local") return null;
  return path.join(localUploadsRoot, ...key.split("/"));
}

function generateKey(productId: string, originalName: string): string {
  const ext = originalName.split(".").pop() || "bin";
  const hash = crypto.randomBytes(8).toString("hex");
  const timestamp = Date.now();
  return `products/${productId}/${timestamp}-${hash}.${ext}`;
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
}

export interface StorageHealth {
  ok: boolean;
  mode: StorageMode;
  message: string;
  error?: string;
}

export async function checkStorageHealth(): Promise<StorageHealth> {
  if (getStorageMode() === "r2") {
    try {
      getClient();
      return {
        ok: true,
        mode: "r2",
        message: "R2/S3 configurado",
      };
    } catch (err) {
      return {
        ok: false,
        mode: "r2",
        message: "R2/S3 inválido",
        error: (err as Error).message,
      };
    }
  }

  try {
    await fs.mkdir(localUploadsRoot, { recursive: true });
    await fs.access(localUploadsRoot, fsConstants.R_OK | fsConstants.W_OK);
    return {
      ok: true,
      mode: "local",
      message: "storage local acessível",
    };
  } catch (err) {
    return {
      ok: false,
      mode: "local",
      message: "storage local indisponível",
      error: (err as Error).message,
    };
  }
}

export async function uploadBuffer(
  productId: string,
  originalName: string,
  buffer: Buffer,
  contentType: string
): Promise<UploadResult> {
  const key = generateKey(productId, originalName);
  let url = getPublicAssetUrl(key);

  if (getStorageMode() === "r2") {
    const c = getClient();
    await c.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );

    url = publicBase
      ? `${publicBase.replace(/\/$/, "")}/${key}`
      : await getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key }), {
          expiresIn: 7 * 24 * 60 * 60,
        });
  } else {
    const target = resolveStoredFilePath(key);
    if (!target) {
      throw new Error("local_storage_path_unavailable");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
  }

  return { key, url, size: buffer.length };
}

export async function deleteObject(key: string): Promise<void> {
  if (getStorageMode() === "r2") {
    const c = getClient();
    await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }

  const target = resolveStoredFilePath(key);
  if (!target) return;
  await fs.rm(target, { force: true });
}

