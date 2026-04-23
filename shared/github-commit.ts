// Minimal wrapper around GitHub's git-data API for atomic multi-file commits.
// Uses blobs → tree → commit → ref update so N files land in ONE commit, not N.
// Contents API (used by market.ts / scanner.ts) would create one commit per
// file — too noisy for brain-deployed APIs that ship 3-6 files at a time.

export interface CommitFile {
  path: string;
  content: string;
}

export interface CommitOptions {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: CommitFile[];
  token: string;
}

export interface CommitResult {
  ok: boolean;
  sha?: string;
  error?: string;
}

const API = "https://api.github.com";

async function gh<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    /* non-json */
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function attemptCommit(opts: CommitOptions): Promise<CommitResult> {
  const { owner, repo, branch, message, files, token } = opts;

  // 1. Read current head of branch
  const refRes = await gh<{ object: { sha: string } }>(
    token,
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
  );
  if (!refRes.ok || !refRes.data) {
    return { ok: false, error: `ref fetch ${refRes.status}: ${refRes.text.slice(0, 200)}` };
  }
  const parentSha = refRes.data.object.sha;

  // 2. Get parent commit to extract its tree sha
  const commitRes = await gh<{ tree: { sha: string } }>(
    token,
    "GET",
    `/repos/${owner}/${repo}/git/commits/${parentSha}`,
  );
  if (!commitRes.ok || !commitRes.data) {
    return { ok: false, error: `parent commit ${commitRes.status}: ${commitRes.text.slice(0, 200)}` };
  }
  const baseTreeSha = commitRes.data.tree.sha;

  // 3. Upload each file as a blob
  const blobs: { path: string; sha: string }[] = [];
  for (const file of files) {
    const blobRes = await gh<{ sha: string }>(
      token,
      "POST",
      `/repos/${owner}/${repo}/git/blobs`,
      { content: file.content, encoding: "utf-8" },
    );
    if (!blobRes.ok || !blobRes.data) {
      return { ok: false, error: `blob ${file.path} ${blobRes.status}: ${blobRes.text.slice(0, 200)}` };
    }
    blobs.push({ path: file.path, sha: blobRes.data.sha });
  }

  // 4. Build new tree on top of the base
  const treeRes = await gh<{ sha: string }>(
    token,
    "POST",
    `/repos/${owner}/${repo}/git/trees`,
    {
      base_tree: baseTreeSha,
      tree: blobs.map((b) => ({
        path: b.path,
        mode: "100644",
        type: "blob",
        sha: b.sha,
      })),
    },
  );
  if (!treeRes.ok || !treeRes.data) {
    return { ok: false, error: `tree ${treeRes.status}: ${treeRes.text.slice(0, 200)}` };
  }

  // 5. Create the commit pointing at the new tree
  const newCommitRes = await gh<{ sha: string }>(
    token,
    "POST",
    `/repos/${owner}/${repo}/git/commits`,
    { message, tree: treeRes.data.sha, parents: [parentSha] },
  );
  if (!newCommitRes.ok || !newCommitRes.data) {
    return { ok: false, error: `commit ${newCommitRes.status}: ${newCommitRes.text.slice(0, 200)}` };
  }

  // 6. Fast-forward the branch
  const refPatchRes = await gh<unknown>(
    token,
    "PATCH",
    `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { sha: newCommitRes.data.sha, force: false },
  );
  if (!refPatchRes.ok) {
    // 422 on concurrent push — caller should retry
    return {
      ok: false,
      error: `ref update ${refPatchRes.status}: ${refPatchRes.text.slice(0, 200)}`,
    };
  }

  return { ok: true, sha: newCommitRes.data.sha };
}

export async function commitFilesToGithub(opts: CommitOptions): Promise<CommitResult> {
  // One-shot retry on concurrent-push race: another commit landed between our
  // ref-read and ref-patch. Rebuild the commit against the new parent.
  const first = await attemptCommit(opts);
  if (first.ok) return first;
  if (!first.error?.includes("422") && !first.error?.includes("not a fast forward")) {
    return first;
  }
  return attemptCommit(opts);
}
