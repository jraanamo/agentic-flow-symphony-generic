import * as os from 'os';
import * as path from 'path';
import { ServiceConfig, WorkflowDefinition } from '../types';

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

function arr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function obj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function resolveEnv(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('$')) {
    const name = value.slice(1);
    return process.env[name] || null;
  }
  return value;
}

function resolvePath(value: string | undefined): string {
  if (!value) return path.join(os.tmpdir(), 'symphony_workspaces');
  if (value.startsWith('~/') || value === '~') {
    return path.join(os.homedir(), value.slice(2));
  }
  if (value.startsWith('$')) {
    const resolved = resolveEnv(value);
    return resolved ? path.resolve(resolved) : path.join(os.tmpdir(), 'symphony_workspaces');
  }
  return value;
}

export function parseConfig(def: WorkflowDefinition): ServiceConfig {
  const c = def.config;
  const tracker = obj(c['tracker']);
  const polling = obj(c['polling']);
  const workspace = obj(c['workspace']);
  const hooks = obj(c['hooks']);
  const agent = obj(c['agent']);
  const backend = obj(c['agent_backend']);
  const server = obj(c['server']);

  const apiKey = resolveEnv(str(tracker['api_key']));
  const backendApiKey = resolveEnv(str(backend['api_key']));

  const maxConcurrentByState: Record<string, number> = {};
  const byState = obj(agent['max_concurrent_agents_by_state']);
  for (const [k, v] of Object.entries(byState)) {
    const n = num(v);
    if (n && n > 0) maxConcurrentByState[k.toLowerCase()] = n;
  }

  return {
    promptTemplate: def.promptTemplate,
    tracker: {
      kind: 'linear',
      endpoint: str(tracker['endpoint']) ?? 'https://api.linear.app/graphql',
      apiKey: apiKey ?? '',
      projectSlug: str(tracker['project_slug']) ?? '',
      activeStates: arr(tracker['active_states']).length > 0
        ? arr(tracker['active_states'])
        : ['Todo', 'In Progress'],
      terminalStates: arr(tracker['terminal_states']).length > 0
        ? arr(tracker['terminal_states'])
        : ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
    },
    polling: {
      intervalMs: num(polling['interval_ms']) ?? 30000,
    },
    workspace: {
      root: resolvePath(str(workspace['root'])),
    },
    hooks: {
      afterCreate: str(hooks['after_create']) ?? null,
      beforeRun: str(hooks['before_run']) ?? null,
      afterRun: str(hooks['after_run']) ?? null,
      beforeRemove: str(hooks['before_remove']) ?? null,
      timeoutMs: num(hooks['timeout_ms']) ?? 60000,
    },
    agent: {
      maxConcurrentAgents: num(agent['max_concurrent_agents']) ?? 10,
      maxTurns: num(agent['max_turns']) ?? 20,
      maxRetryBackoffMs: num(agent['max_retry_backoff_ms']) ?? 300000,
      maxConcurrentAgentsByState: maxConcurrentByState,
    },
    agentBackend: {
      kind: 'subprocess',
      command: str(backend['command']) ?? 'claude --dangerously-skip-permissions',
      model: str(backend['model']) ?? null,
      apiKey: backendApiKey,
      baseUrl: str(backend['base_url']) ?? null,
      executionPolicy: obj(backend['execution_policy']),
      turnTimeoutMs: num(backend['turn_timeout_ms']) ?? 3600000,
      readTimeoutMs: num(backend['read_timeout_ms']) ?? 5000,
      stallTimeoutMs: num(backend['stall_timeout_ms']) ?? 300000,
    },
    server: {
      port: num(server['port']) ?? null,
    },
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateConfig(config: ServiceConfig): ValidationResult {
  const errors: string[] = [];

  if (config.tracker.kind !== 'linear') {
    errors.push(`unsupported_tracker_kind: ${config.tracker.kind}`);
  }
  if (!config.tracker.apiKey) {
    errors.push('missing_tracker_api_key');
  }
  if (!config.tracker.projectSlug) {
    errors.push('missing_tracker_project_slug');
  }
  if (!config.agentBackend.command) {
    errors.push('missing_agent_backend_command');
  }

  return { valid: errors.length === 0, errors };
}
