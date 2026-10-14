import type { Readable, Writable } from 'node:stream';

export type RpcId = string | number;
export type JsonObject = Record<string, unknown>;
export interface ArgumentRule {
  type: string;
  minItems?: number;
  maxItems?: number;
  items?: ObjectSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: readonly string[];
  default?: unknown;
}
export interface ObjectSchema {
  type: string;
  properties: Record<string, ArgumentRule>;
  required?: string[];
  additionalProperties: boolean;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations?: Record<string, boolean>;
}
export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId | null;
  method: string;
  params?: JsonObject;
}
export interface CliRunOptions {
  signal: AbortSignal;
  emit: (value: unknown) => void;
}
export interface StdioOptions {
  directory?: string;
  agent?: string;
  name?: string;
  product?: string;
  server?: string;
  signal?: AbortSignal;
  run?: (argv: string[], options: CliRunOptions) => Promise<unknown>;
  input?: Readable;
  output?: Writable;
}
export interface KnownFailure extends Error {
  code?: string | number;
  status?: number;
  reason?: string;
  data?: unknown;
  localAgent?: string;
  session?: string;
  requestId?: string;
}
export function knownFailure(value: unknown): KnownFailure {
  return value instanceof Error ? value as KnownFailure : new Error('Operation failed.');
}
