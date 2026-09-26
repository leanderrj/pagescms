import { createOctokitInstance } from "@/lib/utils/octokit";
import { getConfig } from "@/lib/config-store";
import { getSchemaByName } from "@/lib/schema";
import { getAvailableFileNames, getFileExtension, joinPathSegments, normalizePath } from "@/lib/utils/file";
import { getToken } from "@/lib/token";
import { updateFileCache } from "@/lib/github-cache-file";
import { createHttpError, toErrorResponse } from "@/lib/api-error";
import { buildCommitTokens, resolveCommitIdentity, resolveCommitMessage } from "@/lib/commit-message";
import { commitFiles } from "@/lib/github-commit";
import { requireApiUserSession } from "@/lib/session-server";

/**
 * Upload several media files to a folder in a single commit.
 *
 * POST /api/[owner]/[repo]/[branch]/media/[name]
 * Body: { path: string, files: { name: string, content: string (base64) }[] }
 *
 * Requires authentication.
 */

const MAX_FILES = 50;

export async function POST(
  request: Request,
  context: { params: Promise<{ owner: string, repo: string, branch: string, name: string }> }
) {
  try {
    const params = await context.params;
    const sessionResult = await requireApiUserSession();
    if ("response" in sessionResult) return sessionResult.response;
    const user = sessionResult.user;

    const { token } = await getToken(user, params.owner, params.repo, true);
    if (!token) throw new Error("Token not found");

    const config = await getConfig(params.owner, params.repo, params.branch, {
      getToken: async () => token,
    });
    if (!config) throw new Error(`Configuration not found for ${params.owner}/${params.repo}/${params.branch}.`);

    const schema = getSchemaByName(config.object, params.name, "media");
    if (!schema) throw createHttpError(`Media schema not found for ${params.name}.`, 404);

    const data: any = await request.json();
    const folderPath = normalizePath(typeof data.path === "string" ? data.path : schema.input);
    if (!folderPath.startsWith(schema.input)) {
      throw createHttpError(`Invalid path "${data.path}" for media "${params.name}".`, 400);
    }

    const files: { name: string; content: string }[] = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) throw createHttpError("No files to upload.", 400);
    if (files.length > MAX_FILES) throw createHttpError(`Too many files (max ${MAX_FILES} per upload).`, 400);

    for (const file of files) {
      if (typeof file?.name !== "string" || !file.name || file.name.includes("/")) {
        throw createHttpError(`Invalid file name "${file?.name}".`, 400);
      }
      if (typeof file.content !== "string" || !file.content) {
        throw createHttpError(`Missing content for "${file.name}".`, 400);
      }
      if (schema.extensions?.length > 0 && !schema.extensions.includes(getFileExtension(file.name))) {
        throw createHttpError(`Invalid extension "${getFileExtension(file.name)}" for media.`, 400);
      }
    }

    const octokit = createOctokitInstance(token);
    let existingNames = new Set<string>();
    try {
      const response = await octokit.rest.repos.getContent({
        owner: params.owner,
        repo: params.repo,
        path: folderPath,
        ref: params.branch,
      });
      if (Array.isArray(response.data)) {
        existingNames = new Set(response.data.map((item) => item.name));
      }
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }

    const names = getAvailableFileNames(files.map((file) => file.name), existingNames);
    const changes = files.map((file, index) => ({
      path: joinPathSegments([folderPath, names[index]]),
      content: file.content,
    }));

    const commitIdentity = resolveCommitIdentity({
      configObject: config.object,
      identityOverride: schema.commit?.identity,
    });
    const committer = commitIdentity === "user" && user.email
      ? { name: user.name?.trim() || user.email, email: user.email }
      : undefined;
    const userLabel = user.email || user.name || String(user.id || "");
    const hasCreateTemplate = Boolean(schema.commit?.templates?.create || config.object?.settings?.commit?.templates?.create);
    const message = changes.length === 1 || hasCreateTemplate
      ? resolveCommitMessage({
          configObject: config.object,
          templatesOverride: schema.commit?.templates,
          action: "create",
          tokens: buildCommitTokens({
            action: "create",
            owner: params.owner,
            repo: params.repo,
            branch: params.branch,
            path: changes.length === 1 ? changes[0].path : folderPath,
            contentName: params.name,
            user: userLabel,
            userName: committer?.name,
            userEmail: committer?.email,
          }),
        })
      : `Upload ${changes.length} files to ${folderPath} (via Pages CMS)`;

    const result = await commitFiles({
      token,
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      message,
      changes,
      committer,
    });

    for (const file of result.files) {
      await updateFileCache("media", params.owner, params.repo, params.branch, {
        type: "add",
        path: file.path,
        sha: file.sha,
        size: file.size,
        downloadUrl: undefined,
        commit: { sha: result.commitSha, timestamp: result.timestamp },
      });
    }

    const renamedCount = result.files.filter((file, index) => file.path !== joinPathSegments([folderPath, files[index].name])).length;

    return Response.json({
      status: "success",
      message: renamedCount > 0
        ? `${result.files.length} files uploaded; ${renamedCount} renamed to avoid naming conflicts.`
        : `${result.files.length} files uploaded.`,
      data: result.files.map((file) => ({
        type: "file",
        sha: file.sha,
        name: file.path.split("/").pop(),
        path: file.path,
        extension: getFileExtension(file.path),
        size: file.size,
      })),
    });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
};
