/**
 * `@lwb/blob-store` —— 内容寻址快照存储（LWB-007 步骤 3）。
 */

export {
  BlobLayoutError,
  SHA256_HEX_LENGTH,
  isSha256Hex,
  objectPath,
  resolveStorageRef,
  shardOf,
  storageRefOf,
  tempRootOf,
} from './layout.ts';

export {
  BlobGcRefusedError,
  BlobIntegrityError,
  BlobMissingError,
  BlobStore,
  corruptObjectForTest,
  sha256Of,
  type BlobRef,
  type BlobRegistry,
  type BlobStoreOptions,
  type GcReport,
  type PutResult,
  type RegistryBlob,
  type VerifyResult,
} from './store.ts';
