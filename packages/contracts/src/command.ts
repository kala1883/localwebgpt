/** Shell command tool contract. The working directory is the selected workspace root. */
export const COMMAND_SHELLS = ['cmd', 'powershell', 'bash'] as const;
export type CommandShell = (typeof COMMAND_SHELLS)[number];

export interface CommandExecInput {
  readonly workspace_id: string;
  /** Stable per intended execution; exact retries must reuse the same key. */
  readonly idempotency_key: string;
  readonly shell: CommandShell;
  readonly command: string;
}

export interface CommandExecData {
  readonly shell: CommandShell;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  readonly output_withheld: boolean;
  readonly stdout: string;
  readonly stderr: string;
}
