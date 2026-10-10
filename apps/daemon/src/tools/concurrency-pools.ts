/** One command pool per file pool, not one pool per tool or request. */
import { ConcurrencyGate } from '@lwb/limits';

const commandPools = new WeakMap<ConcurrencyGate, ConcurrencyGate>();

export function commandPoolFor(files: ConcurrencyGate): ConcurrencyGate {
  let commands = commandPools.get(files);
  if (commands === undefined) {
    commands = new ConcurrencyGate(files.limits);
    commandPools.set(files, commands);
  }
  return commands;
}

export function concurrencyForOperation(operation: string, files: ConcurrencyGate): ConcurrencyGate {
  return operation === 'command_exec' ? commandPoolFor(files) : files;
}

export function poolDiagnostics(files: ConcurrencyGate, connectionId: string) {
  const view = (pool: ConcurrencyGate) => {
    const state = pool.snapshot();
    return {
      in_flight: state.in_flight,
      connection_in_flight: state.connections[connectionId] ?? 0,
      max_concurrent: state.max_concurrent,
      max_per_connection: state.max_per_connection,
      wait_ms: state.wait_ms,
    };
  };
  // Do not expose other connections' identifiers or per-connection counts.
  return { files: view(files), commands: view(commandPoolFor(files)) };
}
