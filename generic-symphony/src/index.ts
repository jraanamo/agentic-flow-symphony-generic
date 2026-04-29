import * as path from 'path';
import { logger } from './logger';
import { LinearClient } from './tracker/linear';
import { WorkspaceManager } from './workspace/manager';
import { ClaudeAdapter } from './agent/claude';
import { AgentRunner } from './agent/runner';
import { Orchestrator } from './orchestrator/orchestrator';

function resolveWorkflowPath(): string {
  // CLI: --workflow <path> or WORKFLOW_PATH env var, else default to cwd/WORKFLOW.md
  const args = process.argv.slice(2);
  const wfIdx = args.indexOf('--workflow');
  if (wfIdx !== -1 && args[wfIdx + 1]) {
    return path.resolve(args[wfIdx + 1]);
  }
  if (process.env['WORKFLOW_PATH']) {
    return path.resolve(process.env['WORKFLOW_PATH']);
  }
  return path.resolve(process.cwd(), 'WORKFLOW.md');
}

function resolvePort(): number | null {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    const n = parseInt(args[portIdx + 1], 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

async function main(): Promise<void> {
  const workflowPath = resolveWorkflowPath();
  const cliPort = resolvePort();

  logger.info('symphony_init', { workflow_path: workflowPath });

  const trackerClient = new LinearClient(logger.child({ component: 'tracker' }));
  const workspaceManager = new WorkspaceManager(logger.child({ component: 'workspace' }));
  const agentAdapter = new ClaudeAdapter(logger.child({ component: 'agent' }));

  const runner = new AgentRunner({
    tracker: trackerClient,
    workspaceManager,
    adapter: agentAdapter,
    log: logger.child({ component: 'runner' }),
  });

  const orchestrator = new Orchestrator({
    workflowPath,
    tracker: trackerClient,
    workspaceManager,
    runner,
    log: logger.child({ component: 'orchestrator' }),
    cliPort: cliPort ?? undefined,
  });

  // Graceful shutdown
  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown_signal', { signal });
    await orchestrator.stop();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await orchestrator.start();
}

main().catch(err => {
  logger.error('fatal', { error: (err as Error).message });
  process.exit(1);
});
