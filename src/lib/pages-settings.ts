import type { GitLabConfig } from './gitlab-client';
// The Pages builder replaces this file only inside its isolated static build.
export const pagesSettings: GitLabConfig = {
  instance: process.env.NEXT_PUBLIC_GITLAB_URL || 'https://gitlab.com',
  project: process.env.NEXT_PUBLIC_GITLAB_PROJECT || '',
  branch: process.env.NEXT_PUBLIC_GITLAB_BRANCH || 'main',
  clientId: process.env.NEXT_PUBLIC_GITLAB_CLIENT_ID || '',
  directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr',
  copilotClientId: process.env.NEXT_PUBLIC_HOOSPEC_COPILOT_CLIENT_ID || '',
  copilotUrl: process.env.NEXT_PUBLIC_HOOSPEC_COPILOT_URL || '',
  agentUrl: process.env.NEXT_PUBLIC_HOOSPEC_AGENT_URL || '', requireMembership: true,
};
