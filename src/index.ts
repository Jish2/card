import { Hono } from "hono";
import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import { parseHTML } from "linkedom";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";

export const config = {
  runtime: "nodejs",
};

const app = new Hono();
const GITHUB_API_VERSION = "2022-11-28";

type TemplateFieldConfig = {
  id: string;
  selector?: string;
  index?: number;
  attr?: string;
};

type FieldValueMap = Record<string, string>;

const TEMPLATE_FIELD_CONFIGS: TemplateFieldConfig[] = [
  { id: "phone", selector: ".card__phone" },
  { id: "companyWordLeft", selector: ".card__company-word", index: 0 },
  { id: "companyAmpersand", selector: ".card__company-ampersand" },
  { id: "companyWordRight", selector: ".card__company-word", index: 1 },
  { id: "companyTagline", selector: ".card__company-tagline" },
  { id: "personFirst", selector: ".card__person-first" },
  { id: "personLast", selector: ".card__person-last" },
  { id: "title", selector: ".card__title" },
  { id: "address", selector: ".card__bottom-address" },
  {
    id: "faxLabel",
    selector: ".card__bottom-contact--fax .card__bottom-label",
  },
  {
    id: "faxValue",
    selector: ".card__bottom-contact--fax .card__bottom-value",
  },
  {
    id: "telexLabel",
    selector: ".card__bottom-contact--telex .card__bottom-label",
  },
  {
    id: "telexValue",
    selector: ".card__bottom-contact--telex .card__bottom-value",
  },
];

const TEMPLATE_FIELD_MAP = new Map(
  TEMPLATE_FIELD_CONFIGS.map((config) => [config.id, config])
);

const repoConfig = {
  owner: process.env.GITHUB_REPO_OWNER ?? "",
  repo: process.env.GITHUB_REPO_NAME ?? "",
  baseBranch: process.env.GITHUB_REPO_BASE_BRANCH ?? "main",
  pat: process.env.GITHUB_REPO_PAT ?? "",
  commitAuthorName: process.env.GITHUB_COMMIT_AUTHOR_NAME ?? "Card Automation",
  commitAuthorEmail:
    process.env.GITHUB_COMMIT_AUTHOR_EMAIL ?? "card-automation@jgoon.com",
  targetFilePath: process.env.GITHUB_PREVIEW_FILE_PATH ?? "index.html",
};

const sanitizeFieldValue = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
};

const normalizeFieldValues = (
  values: Record<string, unknown> | undefined | null
): FieldValueMap => {
  const result: FieldValueMap = {};
  if (!values || typeof values !== "object") {
    return result;
  }

  for (const [key, rawValue] of Object.entries(values)) {
    if (!TEMPLATE_FIELD_MAP.has(key)) {
      continue;
    }
    result[key] = sanitizeFieldValue(rawValue);
  }

  return result;
};

const getTemplateNode = (doc: any, config: TemplateFieldConfig) => {
  if (!config.selector || typeof doc?.querySelector !== "function") {
    return null;
  }

  if (typeof config.index === "number") {
    const nodes = doc.querySelectorAll(config.selector);
    return nodes?.[config.index] ?? null;
  }

  return doc.querySelector(config.selector);
};

const readTemplateField = (doc: any, config: TemplateFieldConfig): string => {
  const node = getTemplateNode(doc, config);
  if (!node) {
    return "";
  }

  if (config.attr && typeof node.getAttribute === "function") {
    return node.getAttribute(config.attr) ?? "";
  }

  return (node.textContent ?? "").toString();
};

const writeTemplateField = (
  doc: any,
  config: TemplateFieldConfig,
  value: string
) => {
  const node = getTemplateNode(doc, config);
  if (!node) {
    return;
  }

  if (config.attr && typeof node.setAttribute === "function") {
    node.setAttribute(config.attr, value ?? "");
    return;
  }

  node.textContent = value ?? "";
};

const capitalizeWord = (value: string) => {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
};

const applyFieldsToTemplate = (
  templateHtml: string,
  values: FieldValueMap
): { html: string; applied: FieldValueMap } => {
  const { document } = parseHTML(templateHtml);

  const applied: FieldValueMap = {};

  for (const [fieldId, value] of Object.entries(values)) {
    const config = TEMPLATE_FIELD_MAP.get(fieldId);
    if (!config) {
      continue;
    }
    writeTemplateField(document, config, value);
    applied[fieldId] = value;
  }

  const firstConfig = TEMPLATE_FIELD_MAP.get("personFirst");
  const lastConfig = TEMPLATE_FIELD_MAP.get("personLast");
  if (firstConfig && lastConfig) {
    const first = sanitizeFieldValue(readTemplateField(document, firstConfig));
    const last = sanitizeFieldValue(readTemplateField(document, lastConfig));
    const computedTitle = [first, last]
      .filter(Boolean)
      .map(capitalizeWord)
      .join(" ")
      .trim();
    if (computedTitle.length) {
      const titleNode = document.querySelector("title");
      if (titleNode) {
        titleNode.textContent = computedTitle;
      }
    }
  }

  const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
  return { html, applied };
};

const encodeGitHubPath = (path: string) =>
  path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const removeReadmeFromBranch = async (branchName: string) => {
  const readmePath = encodeGitHubPath("README.md");
  const readmeResponse = await githubPatRequest(
    `/repos/${repoConfig.owner}/${
      repoConfig.repo
    }/contents/${readmePath}?ref=${encodeURIComponent(branchName)}`,
    { method: "GET" }
  );

  if (readmeResponse.status === 404) {
    return;
  }

  if (!readmeResponse.ok) {
    const errorText = await readmeResponse.text();
    console.warn("[/github/preview] Unable to load README metadata.", {
      status: readmeResponse.status,
      body: errorText,
    });
    return;
  }

  const readmeData = await readmeResponse.json();
  const readmeSha: string | undefined = readmeData?.sha;
  if (!readmeSha) {
    console.warn("[/github/preview] README metadata missing SHA.");
    return;
  }

  const deleteResponse = await githubPatRequest(
    `/repos/${repoConfig.owner}/${repoConfig.repo}/contents/${readmePath}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `chore: remove README for ${branchName}`,
        branch: branchName,
        sha: readmeSha,
        committer: {
          name: repoConfig.commitAuthorName,
          email: repoConfig.commitAuthorEmail,
        },
        author: {
          name: repoConfig.commitAuthorName,
          email: repoConfig.commitAuthorEmail,
        },
      }),
    }
  );

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    const errorText = await deleteResponse.text();
    console.warn("[/github/preview] Failed to delete README.", {
      status: deleteResponse.status,
      body: errorText,
    });
  }
};

const publicDir = resolve(process.cwd(), "src/public");
const publicDirPrefix = publicDir.endsWith(sep)
  ? publicDir
  : `${publicDir}${sep}`;

const previewTemplatePath = resolve(publicDir, "preview/index.html");

type PreviewRequestBody = {
  fields?: Record<string, unknown>;
  commitMessage?: string;
};

type PreviewBranchResult = {
  branchName: string;
  branchUrl: string;
  vercelImportUrl: string;
};

const githubPatRequest = async (
  path: string,
  init: RequestInit = {}
): Promise<Response> => {
  if (!repoConfig.pat) {
    throw new Error("GitHub PAT is not configured.");
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${repoConfig.pat}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.clone().text();
    console.error(
      `GitHub PAT request failed: ${response.status} ${path}`,
      errorText
    );
  }

  return response;
};

const pushPreviewBranch = async (
  content: string,
  commitMessage: string
): Promise<PreviewBranchResult> => {
  if (!repoConfig.owner || !repoConfig.repo || !repoConfig.pat) {
    throw new Error("GitHub repository configuration is incomplete.");
  }

  const baseRefResponse = await githubPatRequest(
    `/repos/${repoConfig.owner}/${repoConfig.repo}/git/ref/heads/${repoConfig.baseBranch}`,
    { method: "GET" }
  );

  if (!baseRefResponse.ok) {
    throw new Error("Unable to load base branch reference.");
  }

  const baseRefData = await baseRefResponse.json();
  const baseSha: string | undefined = baseRefData?.object?.sha;
  if (!baseSha) {
    throw new Error("Base branch reference missing SHA.");
  }

  const branchName = `card-${randomUUID()}`;
  const branchRef = `refs/heads/${branchName}`;

  const createRefResponse = await githubPatRequest(
    `/repos/${repoConfig.owner}/${repoConfig.repo}/git/refs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: branchRef,
        sha: baseSha,
      }),
    }
  );

  if (!createRefResponse.ok) {
    const errorText = await createRefResponse.text();
    console.error("[/github/preview] Failed to create branch.", {
      status: createRefResponse.status,
      body: errorText,
    });
    throw new Error("Unable to create preview branch.");
  }

  await removeReadmeFromBranch(branchName);

  const encodedPath = encodeGitHubPath(repoConfig.targetFilePath);
  const updateResponse = await githubPatRequest(
    `/repos/${repoConfig.owner}/${repoConfig.repo}/contents/${encodedPath}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: branchName,
        committer: {
          name: repoConfig.commitAuthorName,
          email: repoConfig.commitAuthorEmail,
        },
        author: {
          name: repoConfig.commitAuthorName,
          email: repoConfig.commitAuthorEmail,
        },
      }),
    }
  );

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    console.error("[/github/preview] Failed to update template file.", {
      status: updateResponse.status,
      body: errorText,
    });
    throw new Error("Unable to update template file.");
  }

  return {
    branchName,
    branchUrl: `https://github.com/${repoConfig.owner}/${repoConfig.repo}/tree/${branchName}`,
    vercelImportUrl: `https://vercel.com/new/clone?repository-url=${encodeURIComponent(
      `https://github.com/${repoConfig.owner}/${repoConfig.repo}/tree/${branchName}`
    )}`,
  };
};

const resolvePublicAsset = async (
  requestPath: string
): Promise<string | null> => {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  let normalized = posix.normalize(decodedPath);
  if (normalized === "/") {
    normalized = "/index.html";
  } else if (normalized.endsWith("/")) {
    normalized = `${normalized}index.html`;
  }

  const absolutePath = resolve(publicDir, `.${normalized}`);
  if (!absolutePath.startsWith(publicDirPrefix)) {
    return null;
  }

  try {
    let candidatePath = absolutePath;
    const candidateStats = await stat(candidatePath);
    if (candidateStats.isDirectory()) {
      candidatePath = resolve(candidatePath, "index.html");
      await stat(candidatePath);
    }
    return candidatePath;
  } catch {
    return null;
  }
};

const needsCharset = (mimeType: string) => {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+xml") ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType === "application/json" ||
    mimeType === "application/javascript"
  );
};

const serveFromPublic = async (c: Context) => {
  const filePath = await resolvePublicAsset(c.req.path);
  if (!filePath) {
    return c.notFound();
  }

  const mimeType = getMimeType(filePath) ?? "application/octet-stream";
  const headers = new Headers();
  headers.set(
    "Content-Type",
    needsCharset(mimeType) ? `${mimeType}; charset=utf-8` : mimeType
  );

  if (c.req.method === "HEAD") {
    return c.newResponse(null, { status: 200, headers });
  }

  try {
    const body = await readFile(filePath);
    return c.newResponse(body, { status: 200, headers });
  } catch (error) {
    console.error(`Failed to read asset at ${filePath}`, error);
    return c.text("Unable to load asset", 500);
  }
};

app.post("/github/preview", async (c) => {
  if (!repoConfig.owner || !repoConfig.repo || !repoConfig.pat) {
    console.error("GitHub repository configuration is incomplete.");
    return c.text("GitHub repository not configured.", 500);
  }

  let body: PreviewRequestBody;
  try {
    body = await c.req.json<PreviewRequestBody>();
  } catch {
    return c.text("Invalid JSON body.", 400);
  }

  const normalizedFields = normalizeFieldValues(body.fields);
  if (Object.keys(normalizedFields).length === 0) {
    return c.text("No valid fields provided.", 400);
  }

  let templateHtml: string;
  try {
    templateHtml = await readFile(previewTemplatePath, "utf8");
  } catch (error) {
    console.error("Failed to read preview template from disk.", error);
    return c.text("Unable to load template file.", 500);
  }

  const { html, applied } = applyFieldsToTemplate(
    templateHtml,
    normalizedFields
  );

  const commitMessage =
    typeof body.commitMessage === "string" && body.commitMessage.trim().length
      ? body.commitMessage.trim().slice(0, 250)
      : `chore: update card preview ${new Date().toISOString()}`;

  try {
    const { branchName, branchUrl, vercelImportUrl } = await pushPreviewBranch(
      html,
      commitMessage
    );
    return c.json({
      branch: branchName,
      branchUrl,
      vercelImportUrl,
      appliedFields: applied,
    });
  } catch (error) {
    console.error("[/github/preview] Failed to publish preview.", error);
    return c.text("Failed to publish preview.", 500);
  }
});

app.get("/*", serveFromPublic);
app.on("HEAD", "/*", serveFromPublic);

export default app;
