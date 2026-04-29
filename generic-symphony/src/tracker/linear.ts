import { Issue, BlockerRef, ServiceConfig } from '../types';
import { Logger } from '../logger';

const CANDIDATE_QUERY = `
query CandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
  issues(
    first: 50
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      relations {
        nodes {
          type
          relatedIssue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATES_BY_IDS_QUERY = `
query IssueStatesByIds($ids: [ID!]!) {
  issues(filter: { id: { in: $ids } }) {
    nodes {
      id
      identifier
      state { name }
    }
  }
}`;

const ISSUES_BY_STATES_QUERY = `
query IssuesByStates($projectSlug: String!, $states: [String!]!, $after: String) {
  issues(
    first: 50
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
  ) {
    nodes {
      id
      identifier
      state { name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface GqlResponse {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

export class LinearClient {
  constructor(private log: Logger) {}

  async fetchCandidateIssues(config: ServiceConfig): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;

    do {
      const resp = await this.request(config, CANDIDATE_QUERY, {
        projectSlug: config.tracker.projectSlug,
        states: config.tracker.activeStates,
        after: cursor,
      });

      const connection = (resp.data?.['issues'] as IssuesConnection | undefined);
      if (!connection) throw new Error('linear_unknown_payload: missing issues field');

      for (const node of connection.nodes ?? []) {
        issues.push(normalizeIssue(node));
      }

      if (connection.pageInfo?.hasNextPage) {
        if (!connection.pageInfo.endCursor) {
          throw new Error('linear_missing_end_cursor');
        }
        cursor = connection.pageInfo.endCursor;
      } else {
        cursor = null;
      }
    } while (cursor !== null);

    return issues;
  }

  async fetchIssuesByStates(stateNames: string[], config: ServiceConfig): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;

    do {
      const resp = await this.request(config, ISSUES_BY_STATES_QUERY, {
        projectSlug: config.tracker.projectSlug,
        states: stateNames,
        after: cursor,
      });

      const connection = resp.data?.['issues'] as IssuesConnection | undefined;
      if (!connection) throw new Error('linear_unknown_payload: missing issues field');

      for (const node of connection.nodes ?? []) {
        issues.push(normalizeIssue(node));
      }

      if (connection.pageInfo?.hasNextPage) {
        if (!connection.pageInfo.endCursor) throw new Error('linear_missing_end_cursor');
        cursor = connection.pageInfo.endCursor;
      } else {
        cursor = null;
      }
    } while (cursor !== null);

    return issues;
  }

  async fetchIssueStatesByIds(
    ids: string[],
    config: ServiceConfig,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;

    const resp = await this.request(config, STATES_BY_IDS_QUERY, { ids });
    const connection = resp.data?.['issues'] as IssuesConnection | undefined;
    if (!connection) throw new Error('linear_unknown_payload: missing issues field');

    for (const node of connection.nodes ?? []) {
      if (node.id && node.state?.name) {
        result.set(node.id as string, node.state.name as string);
      }
    }

    return result;
  }

  private async request(
    config: ServiceConfig,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GqlResponse> {
    const body = JSON.stringify({ query, variables });

    let resp: Response;
    try {
      resp = await fetch(config.tracker.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': config.tracker.apiKey,
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new Error(`linear_api_request: ${(err as Error).message}`);
    }

    if (!resp.ok) {
      throw new Error(`linear_api_status: HTTP ${resp.status}`);
    }

    let json: GqlResponse;
    try {
      json = await resp.json() as GqlResponse;
    } catch (err) {
      throw new Error(`linear_unknown_payload: failed to parse response JSON`);
    }

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map(e => e.message).join('; ');
      throw new Error(`linear_graphql_errors: ${msg}`);
    }

    return json;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IssueNode = Record<string, any>;

interface IssuesConnection {
  nodes?: IssueNode[];
  pageInfo?: { hasNextPage: boolean; endCursor?: string };
}

function normalizeIssue(node: IssueNode): Issue {
  const labels: string[] = (node.labels?.nodes ?? [])
    .map((l: IssueNode) => (typeof l.name === 'string' ? l.name.toLowerCase() : ''))
    .filter(Boolean);

  const blockedBy: BlockerRef[] = (node.relations?.nodes ?? [])
    .filter((r: IssueNode) => r.type === 'blocked_by')
    .map((r: IssueNode) => ({
      id: r.relatedIssue?.id ?? null,
      identifier: r.relatedIssue?.identifier ?? null,
      state: r.relatedIssue?.state?.name ?? null,
    }));

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: typeof node.description === 'string' ? node.description : null,
    priority: typeof node.priority === 'number' ? node.priority : null,
    state: node.state?.name ?? '',
    branchName: typeof node.branchName === 'string' ? node.branchName : null,
    url: typeof node.url === 'string' ? node.url : null,
    labels,
    blockedBy,
    createdAt: node.createdAt ? new Date(node.createdAt) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}
