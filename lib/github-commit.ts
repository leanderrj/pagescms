import { createOctokitInstance } from "@/lib/utils/octokit";

/**
 * Commit several file changes to a branch as a single commit using the Git
 * Data API (blobs -> tree -> commit -> ref).
 */

type CommitFileChange =
  | { path: string; content: string } // base64
  | { path: string; delete: true };

type CommitFilesResult = {
  commitSha: string;
  timestamp: number;
  files: { path: string; sha: string; size: number }[];
};

const MAX_ATTEMPTS = 4;

// The branch moved between reading the head and updating the ref (another
// commit landed, or GitHub is still syncing a previous one). Safe to rebuild
// the commit on the new head and retry.
const isBranchMovedError = (error: any) => {
  const message = [error?.response?.data?.message, error?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (error?.status === 409) return /is at [0-9a-f]{7,40} but expected [0-9a-f]{7,40}/i.test(message);
  if (error?.status === 422) return /fast forward/i.test(message);
  return false;
};

const commitFiles = async ({
  token,
  owner,
  repo,
  branch,
  message,
  changes,
  committer,
}: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  message: string;
  changes: CommitFileChange[];
  committer?: { name: string; email: string };
}): Promise<CommitFilesResult> => {
  if (changes.length === 0) throw new Error("No changes to commit.");

  const octokit = createOctokitInstance(token);

  // Blobs don't depend on the parent commit, so they're created once and
  // reused across retries.
  const entries = await Promise.all(changes.map(async (change) => {
    if ("delete" in change) {
      return { path: change.path, sha: null, size: 0 };
    }
    const response = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: change.content,
      encoding: "base64",
    });
    return {
      path: change.path,
      sha: response.data.sha,
      size: Math.floor(change.content.length * 3 / 4) - (change.content.match(/=*$/)?.[0].length ?? 0),
    };
  }));

  for (let attempt = 1; ; attempt++) {
    try {
      const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const headSha = ref.data.object.sha;
      const headCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });

      const tree = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: headCommit.data.tree.sha,
        tree: entries.map((entry) => ({
          path: entry.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: entry.sha,
        })),
      });

      const commit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.data.sha,
        parents: [headSha],
        author: committer,
        committer,
      });

      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      });

      return {
        commitSha: commit.data.sha,
        timestamp: new Date(commit.data.committer?.date ?? Date.now()).getTime(),
        files: entries
          .filter((entry): entry is { path: string; sha: string; size: number } => entry.sha !== null)
          .map(({ path, sha, size }) => ({ path, sha, size })),
      };
    } catch (error) {
      if (!isBranchMovedError(error) || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
};

export { commitFiles, isBranchMovedError };
export type { CommitFileChange, CommitFilesResult };
