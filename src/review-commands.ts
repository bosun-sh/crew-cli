import { gh } from './publication.js';

export function revisionCommand(value: unknown): { id: number; author: string; feedback: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const comment = value as { id?: unknown; body?: unknown; user?: { login?: unknown } };
  if (!Number.isSafeInteger(comment.id) || typeof comment.body !== 'string' || typeof comment.user?.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(comment.user.login)) return undefined;
  const match = comment.body.trim().match(/^\/crew revise\s+([\s\S]+)$/);
  const feedback = match?.[1]?.trim();
  if (!feedback || feedback.length > 20_000) return undefined;
  return { id: comment.id as number, author: comment.user.login, feedback };
}

export function authorizedRevisions(root: string, repo: string, prNumber: number, runGh = gh) {
  const pages: unknown = JSON.parse(runGh({ root }, ['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp']));
  if (!Array.isArray(pages)) throw new Error('Invalid GitHub comment response');
  const commands = pages.flat().map(revisionCommand).filter((item) => item !== undefined);
  const permissions = new Map<string, string>();
  return commands.filter((command) => {
    let permission = permissions.get(command.author);
    if (!permission) {
      permission = runGh({ root }, ['api', `repos/${repo}/collaborators/${command.author}/permission`, '--jq', '.permission']).trim();
      permissions.set(command.author, permission);
    }
    return ['admin', 'maintain', 'write'].includes(permission);
  }).slice(-10);
}
