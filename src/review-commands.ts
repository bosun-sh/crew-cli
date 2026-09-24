import { gh } from './publication.js';

export function revisionCommand(value: unknown): { id: number; author: string; feedback: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const comment = value as { id?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown } };
  if (comment.user?.type === 'Bot') return undefined;
  if (!Number.isSafeInteger(comment.id) || typeof comment.body !== 'string' || typeof comment.user?.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(comment.user.login)) return undefined;
  const match = comment.body.trim().match(/^\/crew revise\s+([\s\S]+)$/);
  const feedback = match?.[1]?.trim();
  if (!feedback || feedback.length > 20_000) return undefined;
  return { id: comment.id as number, author: comment.user.login, feedback };
}

export function authorizedRevisions(root: string, repo: string, prNumber: number, runGh = gh) {
  const pages: unknown = JSON.parse(runGh({ root }, ['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp']));
  if (!Array.isArray(pages)) throw new Error('Invalid GitHub comment response');
  const commands = pages.flat().map(revisionCommand).filter((item) => item !== undefined).map(item => ({ ...item, source: 'comment' as 'comment' | 'review' }));
  const reviews: unknown = JSON.parse(runGh({ root }, ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--paginate', '--slurp']));
  if (!Array.isArray(reviews)) throw new Error('Invalid GitHub reviews response');
  for (const review of reviews.flat()) {
    if (review?.state !== 'CHANGES_REQUESTED' || review.user?.type === 'Bot') continue;
    if (!Number.isSafeInteger(review.id) || typeof review.user?.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(review.user.login)) throw new Error('Invalid GitHub review identity');
    const inline: unknown = JSON.parse(runGh({ root }, ['api', `repos/${repo}/pulls/${prNumber}/reviews/${review.id}/comments`, '--paginate', '--slurp']));
    if (!Array.isArray(inline)) throw new Error('Incomplete GitHub review feedback');
    const parts = [typeof review.body === 'string' ? review.body.trim() : ''];
    for (const comment of inline.flat()) {
      if (typeof comment?.body !== 'string' || typeof comment.path !== 'string') throw new Error('Invalid inline review feedback');
      parts.push(`${comment.path}${comment.line ? `:${comment.line}` : ''}\n${comment.body}`);
    }
    const feedback = parts.filter(Boolean).join('\n\n');
    if (!feedback) continue;
    if (feedback.length > 20_000) throw new Error('Review exceeds feedback limit; submit a focused revision request.');
    commands.push({ id: review.id, author: review.user.login, feedback, source: 'review' });
  }
  const permissions = new Map<string, string>();
  return commands.filter((command) => {
    let permission = permissions.get(command.author);
    if (!permission) {
      permission = runGh({ root }, ['api', `repos/${repo}/collaborators/${command.author}/permission`, '--jq', '.permission']).trim();
      permissions.set(command.author, permission);
    }
    return ['admin', 'maintain', 'write'].includes(permission);
  });
}
