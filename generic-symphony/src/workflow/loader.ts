import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { WorkflowDefinition } from '../types';

const FRONT_MATTER_FENCE = '---';

export function loadWorkflow(filePath: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`missing_workflow_file: cannot read ${filePath}: ${(err as Error).message}`);
  }

  if (!raw.startsWith(FRONT_MATTER_FENCE)) {
    return { config: {}, promptTemplate: raw.trim() };
  }

  const afterFence = raw.slice(FRONT_MATTER_FENCE.length);
  const closingIdx = afterFence.indexOf('\n' + FRONT_MATTER_FENCE);
  if (closingIdx === -1) {
    throw new Error('workflow_parse_error: unclosed YAML front matter');
  }

  const frontMatterRaw = afterFence.slice(0, closingIdx);
  const bodyRaw = afterFence.slice(closingIdx + 1 + FRONT_MATTER_FENCE.length);

  let config: unknown;
  try {
    config = yaml.load(frontMatterRaw);
  } catch (err) {
    throw new Error(`workflow_parse_error: invalid YAML: ${(err as Error).message}`);
  }

  if (config !== null && typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('workflow_front_matter_not_a_map: YAML front matter must be a mapping object');
  }

  return {
    config: (config as Record<string, unknown>) ?? {},
    promptTemplate: bodyRaw.trim(),
  };
}
