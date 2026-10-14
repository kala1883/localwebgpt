/** Browser-safe local-console contract. None of these endpoints is an MCP tool. */
import { z } from 'zod';
export const CONVERSATION_MANAGEMENT_VERSION = '1.0.0';
export const conversationId = z.string().regex(/^conversation_[a-f0-9-]{36}$/);
const callId = z.string().regex(/^call_[a-f0-9-]{36}$/);
const jobId = z.string().regex(/^job_[a-f0-9-]{36}$/);
export const attributionSchema = z.enum(['client_meta','unassigned_missing','unassigned_invalid','unassigned_legacy']);
const nonnegative = z.number().int().nonnegative();
const cursor = z.string().max(4096).optional();
export const sessionListInput = z.strictObject({
  query: z.string().max(160).optional(), tag: z.string().max(48).optional(),
  connection_id: z.string().max(128).optional(), workspace_id: z.string().max(128).optional(),
  attribution: attributionSchema.optional(), archived: z.enum(['active','archived','all']).default('active'),
  pinned: z.boolean().optional(), state: z.enum(['all','running','unknown','closed']).default('all'),
  after: cursor, max_items: z.number().int().min(1).max(100).default(30),
});
export type SessionListInput = z.infer<typeof sessionListInput>;
export const sessionItemsInput = z.strictObject({
  conversation_id: conversationId, kind: z.enum(['calls','jobs','events','management']),
  after: cursor, max_items: z.number().int().min(1).max(100).default(30),
  call_id: callId.optional(), job_id: jobId.optional(), query: z.string().max(160).optional(),
});
export type SessionItemsInput = z.infer<typeof sessionItemsInput>;
export const sessionUpdateInput = z.strictObject({
  conversation_id: conversationId, expected_revision: nonnegative,
  local_title: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(32)).max(12),
  notes: z.string().max(4000), pinned: z.boolean(), archived: z.boolean(),
});
export type SessionUpdateInput = z.infer<typeof sessionUpdateInput>;
export const settingsUpdateInput = z.strictObject({
  expected_revision: nonnegative, retention_days: z.number().int().min(1).max(3650),
  automatic_retention: z.boolean(),
});
export const sessionSummarySchema = z.object({
  id: conversationId, connection_id: z.string(), local_title: z.string(), title_source: z.string(),
  attribution: attributionSchema, created_at: z.string(), last_activity_at: z.string(),
  revision: nonnegative, tags: z.array(z.string()), notes: z.string(), pinned: z.boolean(), archived: z.boolean(),
  payload_generation: nonnegative, payloads_cleared_at: z.string().nullable(),
  call_count: nonnegative, job_count: nonnegative, event_count: nonnegative, event_bytes: nonnegative,
  pending_calls: nonnegative, running_jobs: nonnegative, unknown_jobs: nonnegative, failed_calls: nonnegative,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const pageSchema = z.object({
  items: z.array(z.record(z.string(),z.unknown())), next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type ArchivePage = z.infer<typeof pageSchema>;
export const sessionListSchema = z.object({items:z.array(sessionSummarySchema),next_cursor:z.string().nullable(),has_more:z.boolean()});
export const settingsSchema = z.object({revision:nonnegative,retention_days:nonnegative,automatic_retention:z.boolean(),updated_at:z.string()});
export type ArchiveSettings = z.infer<typeof settingsSchema>;
export const statusSchema = z.object({
  feature_version: z.literal('1.0.0'), schema_version:z.literal(11),
  settings:settingsSchema, statistics:z.object({conversations:nonnegative,calls:nonnegative,jobs:nonnegative,events:nonnegative,bytes:nonnegative,unassigned:nonnegative}),
  archive_health: z.record(z.string(),z.unknown()),
  connections:z.array(z.object({id:z.string(),label:z.string()})),
  workspaces:z.array(z.object({id:z.string(),label:z.string()})),
});
export type ArchiveStatus = z.infer<typeof statusSchema>;
export const clearPreviewSchema = z.object({
  conversation_id:conversationId,allowed:z.boolean(),blockers:z.array(z.string()),
  events:nonnegative,bytes:nonnegative,revision:nonnegative,digest:z.string(),
});
export type ClearPreview = z.infer<typeof clearPreviewSchema>;
export const exportPageSchema = z.object({
  filename:z.string(),format:z.literal('jsonl'),lines:z.array(z.string()),
  next_cursor:z.string().nullable(),has_more:z.boolean(),
  high_water:nonnegative,consistency:z.literal('header_at_start_and_immutable_events_through_high_water'),
});
export type ExportPage = z.infer<typeof exportPageSchema>;
