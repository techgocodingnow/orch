// Pull request feedback through the gh CLI: what still needs an answer on a PR.
import { execFile } from 'node:child_process';

const QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  number url state isDraft headRefName reviewDecision author{login}
  commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name status conclusion detailsUrl}
    ... on StatusContext{context state targetUrl}}}}}}}
  reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{author{login __typename} body url createdAt}}}}
  reviews(last:50){nodes{author{login __typename} state body submittedAt url}}
  comments(last:50){nodes{author{login __typename} body createdAt url}}
}}}`;

export function ghExec(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

// "123", "#123" or a PR URL. Owner and repo come from the URL, --repo, or the checkout.
export async function resolvePr(ref, repoFlag, gh = ghExec) {
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(String(ref));
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const number = Number(String(ref ?? '').replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) throw new Error('Pass a PR number or URL');
  if (repoFlag) {
    const [owner, repo] = repoFlag.split('/');
    return { owner, repo, number };
  }
  const here = JSON.parse(await gh(['repo', 'view', '--json', 'owner,name']));
  return { owner: here.owner.login, repo: here.name, number };
}

const isBot = (author) => author?.__typename === 'Bot' || /\[bot\]$/.test(author?.login ?? '');
// The status this tool publishes. It must not count as feedback on itself.
export const STATUS_CONTEXT = 'orch/verification';
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

// Turn the raw PR into the list of things that still need an answer.
export function summarize(pr) {
  const me = pr.author?.login;
  const head = pr.commits.nodes[0]?.commit ?? {};
  const since = head.committedDate ?? '';
  const items = [];

  for (const t of pr.reviewThreads.nodes) {
    const comments = t.comments.nodes;
    const last = comments[comments.length - 1];
    // Resolved threads are done. A thread we answered last is waiting on them.
    if (t.isResolved || !comments.length || last.author?.login === me) continue;
    items.push({
      type: 'thread',
      id: t.id,
      path: t.path,
      line: t.line,
      outdated: t.isOutdated,
      author: comments[0].author?.login,
      bot: isBot(comments[0].author),
      body: comments.map((c) => (comments.length > 1 ? `${c.author?.login}: ${c.body}` : c.body)).join('\n\n'),
      url: comments[0].url,
    });
  }
  // Reviews and plain comments have no resolved state, so only ones newer than
  // the head commit count: older ones were written about code that has changed.
  for (const r of pr.reviews.nodes) {
    if (r.author?.login === me || r.submittedAt < since) continue;
    if (r.state !== 'CHANGES_REQUESTED' && !r.body?.trim()) continue;
    items.push({ type: 'review', state: r.state, author: r.author?.login, bot: isBot(r.author), body: r.body ?? '', url: r.url });
  }
  for (const c of pr.comments.nodes) {
    if (c.author?.login === me || c.createdAt < since || !c.body?.trim()) continue;
    items.push({ type: 'comment', author: c.author?.login, bot: isBot(c.author), body: c.body, url: c.url });
  }

  let pending = 0;
  for (const c of head.statusCheckRollup?.contexts.nodes ?? []) {
    const name = c.name ?? c.context;
    if (name === STATUS_CONTEXT) continue;
    const done = c.__typename === 'CheckRun' ? c.status === 'COMPLETED' : c.state !== 'PENDING' && c.state !== 'EXPECTED';
    const result = c.conclusion ?? c.state;
    if (!done) pending++;
    else if (FAILED.has(result)) items.push({ type: 'check', name, result, url: c.detailsUrl ?? c.targetUrl });
  }

  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    branch: pr.headRefName,
    head: head.oid,
    reviewDecision: pr.reviewDecision,
    pendingChecks: pending,
    items,
    clean: items.length === 0 && pending === 0,
  };
}

export async function feedback(target, { gh = ghExec, waitMinutes = 0, pollSeconds = 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  const fetchOnce = async () => {
    const out = await gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${target.owner}`, '-F', `repo=${target.repo}`, '-F', `number=${target.number}`]);
    const pr = JSON.parse(out).data?.repository?.pullRequest;
    if (!pr) throw new Error(`PR ${target.owner}/${target.repo}#${target.number} not found`);
    return summarize(pr);
  };
  const deadline = Date.now() + waitMinutes * 60_000;
  let result = await fetchOnce();
  // Wait for checks (CI, Bugbot and other review bots run as checks) to finish.
  while (result.pendingChecks > 0 && Date.now() < deadline) {
    log(`waiting on ${result.pendingChecks} check(s)`);
    await sleep(pollSeconds * 1000);
    result = await fetchOnce();
  }
  return { ...result, timedOut: result.pendingChecks > 0 && waitMinutes > 0 };
}

export async function reply(threadId, body, { gh = ghExec, resolve = false } = {}) {
  await gh(['api', 'graphql', '-f', 'query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}', '-F', `id=${threadId}`, '-f', `body=${body}`]);
  if (resolve) {
    await gh(['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}', '-F', `id=${threadId}`]);
  }
}

// The gate: one status on the PR that says whether it may be approved.
//   failure  a criterion failed, or a CI check failed
//   pending  waiting on a human look, on review feedback, or on running checks
//   success  every criterion passed, nothing unanswered, checks green
export function decide(verification, fb, independent = null) {
  const failedChecks = fb.items.filter((i) => i.type === 'check');
  const open = fb.items.filter((i) => i.type !== 'check');
  const manual = verification.criteria.filter((c) => c.status === 'needs_human');
  const flags = verification.flags ?? [];
  if (verification.head && fb.head && verification.head !== fb.head) return { state: 'pending', description: 'Verification ran on a different commit than the PR head. Run it again.' };
  if (verification.dirty) return { state: 'pending', description: 'Verification ran with uncommitted changes. Commit, push, run it again.' };
  if (verification.verdict === 'fail') return { state: 'failure', description: `${verification.criteria.filter((c) => c.status === 'fail').length} acceptance criterion(s) failed` };
  if (failedChecks.length) return { state: 'failure', description: `CI failed: ${failedChecks.map((c) => c.name).join(', ')}`.slice(0, 140) };
  if (fb.pendingChecks) return { state: 'pending', description: `${fb.pendingChecks} check(s) still running` };
  if (open.length) return { state: 'pending', description: `${open.length} review item(s) unanswered` };
  if (manual.length) return { state: 'pending', description: `Needs a human to check: ${manual.map((c) => c.id).join(', ')}`.slice(0, 140) };
  if (flags.length) return { state: 'pending', description: flags[0].slice(0, 140) };
  // independent: null when no verdict is required, else the result of judgeVerdict.
  if (independent?.failed) return { state: 'failure', description: independent.reason.slice(0, 140) };
  if (independent && !independent.ok) return { state: 'pending', description: independent.reason.slice(0, 140) };
  return { state: 'success', description: `All ${verification.criteria.length} acceptance criteria passed` };
}

export async function gate(target, verification, report, { approve = 'human', gh = ghExec, independent = null } = {}) {
  const fb = await feedback(target, { gh });
  const decision = decide(verification, fb, independent);
  const repo = `${target.owner}/${target.repo}`;
  await gh(['api', `repos/${repo}/statuses/${fb.head}`, '-f', `state=${decision.state}`, '-f', `context=${STATUS_CONTEXT}`, '-f', `description=${decision.description}`]);
  const body = `${report}\n**Gate: ${decision.state}.** ${decision.description}\n`;
  await gh(['pr', 'comment', String(target.number), '--repo', repo, '--edit-last', '--create-if-none', '--body', body]);
  let approval = decision.state === 'success' ? 'ready for a human to approve' : 'not ready';
  // Observe mode: record what auto would have done, and leave the PR to a person.
  if (decision.state === 'success' && approve === 'observe') approval = 'would have auto-merged (observe mode); ready for a human to approve';
  if (decision.state === 'success' && approve === 'auto') {
    // Hands the merge to GitHub: it lands once branch protection is satisfied,
    // and only at the commit that was verified.
    await gh(['pr', 'merge', String(target.number), '--repo', repo, '--auto', '--squash', '--match-head-commit', fb.head]);
    approval = 'auto-merge enabled';
  }
  return { ...decision, approval, url: fb.url, head: fb.head };
}

export function renderFeedback(f) {
  const lines = [`PR #${f.number} ${f.url}`, `state ${f.state}, review ${f.reviewDecision ?? 'none'}, ${f.pendingChecks} check(s) pending`];
  if (f.clean) lines.push('', 'Nothing to fix.');
  for (const [i, it] of f.items.entries()) {
    const who = it.author ? `${it.author}${it.bot ? ' (bot)' : ''}` : '';
    const head = { thread: `${it.path}:${it.line ?? '?'}${it.outdated ? ' (outdated)' : ''}  ${who}  thread ${it.id}`, review: `review ${it.state}  ${who}`, comment: `comment  ${who}`, check: `check failed: ${it.name} (${it.result})` }[it.type];
    lines.push('', `[${i + 1}] ${head}`, ...(it.body ? [it.body.trim()] : []), ...(it.url ? [it.url] : []));
  }
  return lines.join('\n');
}
