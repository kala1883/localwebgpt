/** Pure Secure MCP Tunnel command contract used by the local launcher. */

export const TUNNEL_ID_ENV = 'CONTROL_PLANE_TUNNEL_ID';
export const TUNNEL_API_KEY_ENV = 'CONTROL_PLANE_API_KEY';

const MCP_COMMAND = 'command=node --import tsx apps/daemon/src/lifecycle/run-mcp-adapter.ts,channel=main';

/** Remove the upstream-only credentials before loading the MCP adapter modules. */
export function stripTunnelCredentials(env: NodeJS.ProcessEnv): void {
  delete env[TUNNEL_API_KEY_ENV];
  delete env['OPENAI_API_KEY'];
  delete env[TUNNEL_ID_ENV];
  delete env['LWB_IPC_SECRET_CONSOLE'];
}

export function tunnelClientArguments(
  action: 'doctor' | 'run',
  tunnelId: string,
): readonly string[] {
  return [
    action,
    '--control-plane.api-key',
    `env:${TUNNEL_API_KEY_ENV}`,
    '--control-plane.tunnel-id',
    tunnelId,
    '--mcp.command',
    MCP_COMMAND,
    ...(action === 'doctor' ? ['--explain'] : []),
  ];
}
