import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Issue, ServiceConfig, WorkspaceResult } from '../types';
import { Logger } from '../logger';

function sanitizeKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class WorkspaceManager {
  constructor(private log: Logger) {}

  async prepare(issue: Issue, config: ServiceConfig): Promise<WorkspaceResult> {
    const key = sanitizeKey(issue.identifier);
    const wsPath = path.resolve(config.workspace.root, key);

    // Safety: ensure path is under workspace root
    const root = path.resolve(config.workspace.root);
    if (!wsPath.startsWith(root + path.sep) && wsPath !== root) {
      throw new Error(`invalid_workspace_cwd: path escapes workspace root`);
    }

    let createdNow = false;
    if (!fs.existsSync(wsPath)) {
      fs.mkdirSync(wsPath, { recursive: true });
      createdNow = true;
    }

    const result: WorkspaceResult = { path: wsPath, workspaceKey: key, createdNow };

    if (createdNow && config.hooks.afterCreate) {
      this.log.info('hook_start', { hook: 'after_create', workspace: wsPath });
      try {
        await this.runScript(config.hooks.afterCreate, wsPath, config.hooks.timeoutMs);
      } catch (err) {
        // Partial workspace — remove it
        fs.rmSync(wsPath, { recursive: true, force: true });
        throw new Error(`after_create hook failed: ${(err as Error).message}`);
      }
    }

    return result;
  }

  async runHook(
    name: 'before_run' | 'after_run' | 'before_remove',
    workspacePath: string,
    config: ServiceConfig,
  ): Promise<void> {
    const scripts: Record<string, string | null> = {
      before_run: config.hooks.beforeRun,
      after_run: config.hooks.afterRun,
      before_remove: config.hooks.beforeRemove,
    };

    const script = scripts[name];
    if (!script) return;

    this.log.info('hook_start', { hook: name, workspace: workspacePath });
    try {
      await this.runScript(script, workspacePath, config.hooks.timeoutMs);
    } catch (err) {
      if (name === 'before_run') throw err;
      // after_run / before_remove failures are logged and ignored
      this.log.warn('hook_failed', { hook: name, error: (err as Error).message });
    }
  }

  async removeWorkspace(identifier: string, config: ServiceConfig): Promise<void> {
    const key = sanitizeKey(identifier);
    const wsPath = path.resolve(config.workspace.root, key);

    if (!fs.existsSync(wsPath)) return;

    await this.runHook('before_remove', wsPath, config);

    this.log.info('workspace_remove', { workspace: wsPath });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }

  private runScript(script: string, cwd: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-lc', script], {
        cwd,
        stdio: 'inherit',
        timeout: timeoutMs,
      });

      proc.on('close', (code, signal) => {
        if (signal) return reject(new Error(`killed by signal ${signal}`));
        if (code !== 0) return reject(new Error(`exited with code ${code}`));
        resolve();
      });

      proc.on('error', reject);
    });
  }
}
