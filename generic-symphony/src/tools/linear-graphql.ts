import * as fs from 'fs';
import * as path from 'path';
import { ServiceConfig } from '../types';
import { Logger } from '../logger';

const BIN_DIR = '.symphony-bin';
const SCRIPT_NAME = 'linear-graphql';

/**
 * Write a bash helper script into the workspace that implements the
 * `linear_graphql` client-side tool (spec §10.5).
 *
 * The script uses LINEAR_API_KEY and LINEAR_ENDPOINT from the environment —
 * both of which are injected by the ClaudeAdapter — so the agent never needs
 * to read raw API tokens from disk.
 *
 * Usage from the agent's bash session:
 *   linear-graphql '{"query":"query { viewer { id } }"}'
 *   linear-graphql '{"query":"...","variables":{"id":"abc"}}'
 *
 * Returns:
 *   { "success": true,  "data": { ... } }
 *   { "success": false, "errors": [...], "data": ... }
 */
const SCRIPT_BODY = `#!/usr/bin/env bash
# linear-graphql — Symphony client-side Linear GraphQL tool
# Injected by Symphony. Do not edit; it is regenerated on each run.
set -euo pipefail

if [ -z "\${LINEAR_API_KEY:-}" ]; then
  echo '{"success":false,"error":"LINEAR_API_KEY is not set"}' >&2
  exit 1
fi

ENDPOINT="\${LINEAR_ENDPOINT:-https://api.linear.app/graphql}"
INPUT="\${1:-}"

if [ -z "$INPUT" ]; then
  echo '{"success":false,"error":"usage: linear-graphql <json-body>"}' >&2
  exit 1
fi

# Validate that input contains a "query" key (lightweight check)
if ! echo "$INPUT" | grep -q '"query"'; then
  echo '{"success":false,"error":"input must contain a \\"query\\" field"}' >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\\n__HTTP_STATUS__%{http_code}" \\
  -X POST "$ENDPOINT" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: $LINEAR_API_KEY" \\
  -d "$INPUT")

BODY=$(echo "$RESPONSE" | sed '$d')
STATUS=$(echo "$RESPONSE" | tail -n1 | sed 's/__HTTP_STATUS__//')

if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 300 ]; then
  echo "{\\"success\\":false,\\"error\\":\\"HTTP $STATUS\\",\\"body\\":$BODY}"
  exit 0
fi

# Check for GraphQL-level errors
if echo "$BODY" | grep -q '"errors"'; then
  echo "{\\"success\\":false,\\"response\\":$BODY}"
else
  echo "{\\"success\\":true,\\"response\\":$BODY}"
fi
`;

export interface ToolEnv {
  /** Extra env vars to inject into the agent subprocess */
  env: Record<string, string>;
  /** Directories to prepend to PATH in the agent subprocess */
  pathPrepend: string[];
}

/**
 * Set up the `linear_graphql` client-side tool in the workspace.
 *
 * Writes the helper script and returns the env overrides + PATH prepend that
 * the ClaudeAdapter should inject into the subprocess.
 */
export function setupLinearGraphqlTool(
  workspacePath: string,
  config: ServiceConfig,
  log: Logger,
): ToolEnv {
  const binDir = path.join(workspacePath, BIN_DIR);
  const scriptPath = path.join(binDir, SCRIPT_NAME);

  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(scriptPath, SCRIPT_BODY, { mode: 0o755 });
    log.debug('linear_graphql_tool_written', { path: scriptPath });
  } catch (err) {
    log.warn('linear_graphql_tool_write_failed', { error: (err as Error).message });
    return { env: {}, pathPrepend: [] };
  }

  const env: Record<string, string> = {};

  // Inject tracker auth so the agent doesn't need to read tokens from disk
  if (config.tracker.apiKey) {
    env['LINEAR_API_KEY'] = config.tracker.apiKey;
  }
  env['LINEAR_ENDPOINT'] = config.tracker.endpoint;

  return { env, pathPrepend: [binDir] };
}
