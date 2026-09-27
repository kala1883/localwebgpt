export {
  AUDIENCES,
  CAPABILITIES,
  CAPABILITIES_BY_AUDIENCE,
  NEVER_GRANTED_TO_MODEL,
  assertAudienceSecretsDistinct,
  capabilitiesOf,
  hasCapability,
  isAudience,
  type Audience,
  type AudienceSecrets,
  type Capability,
} from './audience.ts';

export {
  IPC_PROTOCOL_VERSION,
  NONCE_BYTES,
  computeProof,
  deriveAudienceKey,
  newNonce,
  verifyHandshake,
  type HandshakeFailure,
  type HandshakeRequest,
  type HandshakeVerdict,
} from './handshake.ts';

export { controlPipeName, dataPipeName, describePipe, pipeNameForSid } from './pipe-name.ts';

export {
  MAX_FRAME_BYTES,
  FrameDecoder,
  FrameParseError,
  FrameTooLargeError,
  encodeFrame,
} from './framing.ts';

export {
  OperationRegistry,
  type OperationDefinition,
  type RequestContext,
} from './operations.ts';

export {
  ConnectionSession,
  REQUEST_TIMEOUT_MS,
  attachSocket,
  type MessageSink,
  type SessionEvent,
  type SessionOptions,
} from './server.ts';

export {
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  IpcClient,
  IpcHandshakeError,
  IpcUnavailableError,
  type IpcClientOptions,
  type IpcOutcome,
} from './client.ts';

export {
  ExecutorLease,
  LeaseError,
  classifyProcessHolder,
  newExecutorId,
  type AcquireOutcome,
  type AcquireRefusal,
  type HolderStatus,
  type LeaseOptions,
  type LeaseRecord,
  type ProcessIdentity,
  type ProcessProbe,
} from './lease.ts';

export {
  createProcessProbe,
  currentProcessIdentity,
  nodeProcessProbe,
  type ProcessProbeOptions,
} from './process-probe.ts';

export {
  SingleInstanceError,
  acquireSingleInstance,
  isAddressInUse,
  LOCAL_STOP_ACK,
  LOCAL_STOP_COMMAND,
  releaseSingleInstance,
  type SingleInstanceOutcome,
} from './single-instance.ts';
