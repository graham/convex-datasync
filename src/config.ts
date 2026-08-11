// Credential resolution. Two ways to connect, tried in order:
//
// 1. Explicit: CONVEX_URL + CONVEX_DEPLOY_KEY (env or flags).
// 2. Project directory: CONVEX_DEPLOYMENT (from the project's .env.local,
//    loaded by loadEnvFiles) plus the Convex CLI login in ~/.convex/config.json.
//    Credentials are minted through the same big-brain endpoint the CLI uses.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIG_BRAIN_URL = "https://api.convex.dev/api/";

// Node does not auto-load dotenv files. Loads .env.local
// then .env from the current directory; real environment variables win, and
// .env.local wins over .env.
export function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) {
      continue;
    }
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        // Unquoted values end at an inline comment. The Convex CLI writes
        // these, e.g. CONVEX_DEPLOYMENT=dev:name # team: t, project: p
        const comment = value.search(/\s#/);
        if (comment !== -1) {
          value = value.slice(0, comment).trim();
        }
      }
      if (key !== "" && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export interface Connection {
  url: string;
  deployKey: string;
  deploymentName: string;
}

export function deploymentNameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

// Deployment references look like "dev:happy-otter-123" (or a bare name).
export function stripDeploymentPrefix(reference: string): string {
  const colon = reference.indexOf(":");
  return colon === -1 ? reference : reference.slice(colon + 1);
}

export function configuredDeploymentName(): string | null {
  const configured = process.env.CONVEX_DEPLOYMENT;
  if (!configured) {
    return null;
  }
  return stripDeploymentPrefix(configured) || null;
}

// Best deployment name derivable without any network call, for db naming.
export function localDeploymentName(flags: {
  url?: string;
  deployment?: string;
}): string | null {
  if (flags.deployment) {
    return stripDeploymentPrefix(flags.deployment);
  }
  const url = flags.url ?? process.env.CONVEX_URL;
  if (url) {
    return deploymentNameFromUrl(url);
  }
  return configuredDeploymentName();
}

function readAccessToken(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".convex", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { accessToken?: string };
    return parsed.accessToken ?? null;
  } catch {
    return null;
  }
}

interface AuthorizeResponse {
  url: string;
  adminKey: string;
  deploymentName?: string;
}

async function bigBrainAuthorize(
  path: string,
  body: unknown,
  accessToken: string,
  label: string,
): Promise<AuthorizeResponse> {
  const response = await fetch(BIG_BRAIN_URL + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `could not authorize ${label} (HTTP ${response.status}): ` + (await response.text()),
    );
  }
  const data = (await response.json()) as Partial<AuthorizeResponse>;
  if (!data.url || !data.adminKey) {
    throw new Error(`unexpected authorize response for ${label}`);
  }
  return { url: data.url, adminKey: data.adminKey, deploymentName: data.deploymentName };
}

// Same endpoint the Convex CLI uses for a specific deployment name.
function authorizeDeployment(deploymentName: string, accessToken: string) {
  return bigBrainAuthorize(
    "deployment/authorize_within_current_project",
    {
      selectedDeploymentName: deploymentName,
      projectSelection: { kind: "deploymentName", deploymentName },
    },
    accessToken,
    `deployment ${deploymentName}`,
  );
}

// Resolves the prod deployment of the project that contains `deploymentName`
// (any deployment in the project works as the anchor, e.g. the configured dev
// one). Same endpoint the CLI's --prod flag uses.
function authorizeProd(deploymentName: string, accessToken: string) {
  return bigBrainAuthorize(
    "deployment/authorize_prod",
    { deploymentName },
    accessToken,
    `prod deployment of ${deploymentName}'s project`,
  );
}

export interface ConnectionFlags {
  url?: string;
  deployKey?: string;
  // A specific deployment name (bare or prefixed, e.g. "prod:brave-cat-12").
  deployment?: string;
  // Target the prod deployment of the current project.
  prod?: boolean;
}

export async function resolveConnection(flags: ConnectionFlags): Promise<Connection> {
  const explicitUrl = flags.url ?? process.env.CONVEX_URL;
  const explicitKey = flags.deployKey ?? process.env.CONVEX_DEPLOY_KEY;

  // Fully explicit credentials win, unless --deployment/--prod redirects the
  // target (a key for one deployment is not valid for another).
  if (explicitUrl && explicitKey && !flags.deployment && !flags.prod) {
    return {
      url: explicitUrl,
      deployKey: explicitKey,
      deploymentName: deploymentNameFromUrl(explicitUrl) ?? "deployment",
    };
  }

  const requireAccessToken = (context: string): string => {
    const accessToken = readAccessToken();
    if (!accessToken) {
      throw new Error(`${context} requires a CLI login; run 'npx convex login'`);
    }
    return accessToken;
  };

  if (flags.deployment) {
    const name = stripDeploymentPrefix(flags.deployment);
    console.log(`authorizing deployment ${name} via convex CLI login`);
    const credentials = await authorizeDeployment(name, requireAccessToken(`--deployment ${name}`));
    return { url: credentials.url, deployKey: credentials.adminKey, deploymentName: name };
  }

  // Project context: the configured deployment, or the one in CONVEX_URL.
  const anchor =
    configuredDeploymentName() ?? (explicitUrl ? deploymentNameFromUrl(explicitUrl) : null);

  if (flags.prod) {
    if (!anchor) {
      throw new Error(
        "--prod needs a project context: run from a Convex project directory, " +
          "or use --deployment <name> instead",
      );
    }
    console.log(`authorizing prod deployment of ${anchor}'s project via convex CLI login`);
    const credentials = await authorizeProd(anchor, requireAccessToken("--prod"));
    const deploymentName =
      credentials.deploymentName ?? deploymentNameFromUrl(credentials.url) ?? "prod";
    console.log(`prod deployment is ${deploymentName}`);
    return { url: credentials.url, deployKey: credentials.adminKey, deploymentName };
  }

  if (!anchor) {
    throw new Error(
      "no credentials: set CONVEX_URL and CONVEX_DEPLOY_KEY, or run from a Convex " +
        "project directory (CONVEX_DEPLOYMENT in .env.local)",
    );
  }
  console.log(`authorizing deployment ${anchor} via convex CLI login`);
  const credentials = await authorizeDeployment(anchor, requireAccessToken(`deployment ${anchor}`));
  return { url: credentials.url, deployKey: credentials.adminKey, deploymentName: anchor };
}
