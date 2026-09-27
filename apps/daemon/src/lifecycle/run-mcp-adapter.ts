/**
 * tunnel-client stdio child entry point.
 *
 * The parent tunnel-client needs its control-plane key, and child processes can
 * inherit their parent's environment. Strip those upstream-only values before
 * importing any MCP adapter module; the adapter needs only its audience-bound
 * local IPC credential and connection settings.
 */

import process from 'node:process';

import { stripTunnelCredentials } from './tunnel-client.ts';

stripTunnelCredentials(process.env);
await import('../../../mcp-adapter/src/main.ts');
