import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { ServiceConfig, TokenUsage } from '../types';
import { IAgentAdapter, AgentEvent, TurnResult } from './adapter';
import { Logger } from '../logger';
import { setupLinearGraphqlTool } from '../tools/linear-graphql';

// Claude Code stream-json event shapes
interface ClaudeSystemEvent {
  type: 'system';
  subtype: string;
  session_id?: string;
}

interface ClaudeResultEvent {
  type: 'result';
  subtype: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface ClaudeAssistantEvent {
  type: 'assistant';
  message?: { content?: unknown[] };
  session_id?: string;
}

type ClaudeEvent = ClaudeSystemEvent | ClaudeResultEvent | ClaudeAssistantEvent | { type: string };

function extractText(content: unknown[]): string {
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object')
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text ?? '')
    .join(' ')
    .slice(0, 200);
}

function buildCommand(config: ServiceConfig, sessionId: string | null): string {
  const parts: string[] = [config.agentBackend.command];

  if (config.agentBackend.model) {
    parts.push(`--model ${config.agentBackend.model}`);
  }

  // --verbose is required when combining -p with --output-format stream-json
  parts.push('--output-format stream-json --verbose');
  parts.push(`--max-turns ${config.agent.maxTurns}`);

  if (sessionId) {
    parts.push(`--resume ${sessionId}`);
  }

  // The prompt is injected safely via SYMPHONY_PROMPT env var
  parts.push('-p "$SYMPHONY_PROMPT"');

  return parts.join(' ');
}

export class ClaudeAdapter implements IAgentAdapter {
  constructor(private log: Logger) {}

  async runTurn(
    prompt: string,
    workspacePath: string,
    config: ServiceConfig,
    sessionId: string | null,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    const command = buildCommand(config, sessionId);

    const env: NodeJS.ProcessEnv = { ...process.env };
    env['SYMPHONY_PROMPT'] = prompt;
    if (config.agentBackend.apiKey) env['ANTHROPIC_API_KEY'] = config.agentBackend.apiKey;
    if (config.agentBackend.baseUrl) env['ANTHROPIC_BASE_URL'] = config.agentBackend.baseUrl;

    // Inject linear_graphql client-side tool (spec §10.5)
    if (config.tracker.kind === 'linear') {
      const toolEnv = setupLinearGraphqlTool(workspacePath, config, this.log);
      Object.assign(env, toolEnv.env);
      if (toolEnv.pathPrepend.length > 0) {
        const currentPath = env['PATH'] ?? '';
        env['PATH'] = [...toolEnv.pathPrepend, currentPath].join(':');
      }
    }

    this.log.info('agent_launch', { command: command.replace(/-p ".+"/, '-p "[prompt]"') });

    let proc: ChildProcess;
    try {
      proc = spawn('bash', ['-lc', command], {
        cwd: workspacePath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`agent_not_found: ${(err as Error).message}`);
    }

    const pid = proc.pid ?? null;

    // Forward stderr as debug logs
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.log.debug('agent_stderr', { text: chunk.toString().slice(0, 500) });
    });

    let resolvedSessionId: string | null = sessionId;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let turnFailed = false;
    let failReason = '';
    let inputRequired = false;

    const turnTimeoutHandle = setTimeout(() => {
      this.log.warn('turn_timeout', { pid });
      proc.kill('SIGTERM');
    }, config.agentBackend.turnTimeoutMs);

    const abortHandler = () => {
      clearTimeout(turnTimeoutHandle);
      proc.kill('SIGTERM');
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg: ClaudeEvent;
        try {
          msg = JSON.parse(trimmed) as ClaudeEvent;
        } catch {
          onEvent({ event: 'malformed', timestamp: new Date(), agentPid: pid, raw: trimmed });
          return;
        }

        const now = new Date();

        switch (msg.type) {
          case 'system': {
            const sys = msg as ClaudeSystemEvent;
            if (sys.subtype === 'init') {
              resolvedSessionId = sys.session_id ?? resolvedSessionId;
              onEvent({ event: 'session_started', timestamp: now, agentPid: pid, sessionId: resolvedSessionId ?? undefined });
            }
            break;
          }

          case 'assistant': {
            const asst = msg as ClaudeAssistantEvent;
            const content = asst.message?.content ?? [];
            const text = Array.isArray(content) ? extractText(content) : '';
            onEvent({ event: 'agent_message', timestamp: now, agentPid: pid, message: text });
            break;
          }

          case 'result': {
            const res = msg as ClaudeResultEvent;
            resolvedSessionId = res.session_id ?? resolvedSessionId;

            if (res.usage) {
              const inp = (res.usage.input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);
              const out = res.usage.output_tokens ?? 0;
              usage = { inputTokens: inp, outputTokens: out, totalTokens: inp + out };
              onEvent({ event: 'usage_update', timestamp: now, agentPid: pid, usage });
            }

            if (res.is_error || res.subtype?.startsWith('error')) {
              turnFailed = true;
              failReason = res.subtype ?? 'unknown_error';
              if (res.subtype === 'error_during_turn' && typeof res.result === 'string' && res.result.includes('user input')) {
                inputRequired = true;
              }
            }
            break;
          }

          default:
            onEvent({ event: 'other_message', timestamp: now, agentPid: pid, raw: msg });
        }
      });

      rl.on('close', resolve);
    });

    let procExitCode: number | null = null;

    await new Promise<void>((resolve) => proc.on('close', (code) => {
      procExitCode = code;
      resolve();
    }));

    clearTimeout(turnTimeoutHandle);
    signal.removeEventListener('abort', abortHandler);

    // Non-zero exit with no result event = subprocess crashed before doing any work
    if (!turnFailed && !inputRequired && resolvedSessionId === sessionId && procExitCode !== 0) {
      turnFailed = true;
      failReason = `process_exit: claude exited with code ${procExitCode}`;
    }

    if (signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (inputRequired) {
      onEvent({ event: 'turn_input_required', timestamp: new Date(), agentPid: pid });
      const err = new Error('turn_input_required: agent requested user input');
      err.name = 'TurnInputRequired';
      throw err;
    }

    if (turnFailed) {
      onEvent({ event: 'turn_failed', timestamp: new Date(), agentPid: pid, message: failReason });
      return { sessionId: resolvedSessionId, usage, success: false, errorMessage: failReason };
    }

    onEvent({ event: 'turn_completed', timestamp: new Date(), agentPid: pid, sessionId: resolvedSessionId ?? undefined, usage });
    return { sessionId: resolvedSessionId, usage, success: true };
  }
}
