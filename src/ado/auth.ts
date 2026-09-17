import { run } from "../util/proc.ts";

/** Azure DevOps first-party application id; the resource to request tokens for. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export interface Credential {
  header: string;
  /** Where the credential came from, for diagnostics. */
  source: "pat-env" | "az-cli";
}

let cached: Credential | undefined;

/**
 * Resolves an Azure DevOps credential.
 *
 * A personal access token in the environment wins because it costs nothing.
 * Falling back to the Azure CLI is correct but slow: on WSL the `az` shim runs
 * a Windows python.exe and takes several seconds, so the token is cached for
 * the lifetime of the process and every command is designed to need it once.
 */
export async function getCredential(): Promise<Credential> {
  if (cached) return cached;

  const pat =
    process.env.AZURE_DEVOPS_EXT_PAT ||
    process.env.AZURE_DEVOPS_PAT ||
    process.env.SYSTEM_ACCESSTOKEN;
  if (pat && pat.trim()) {
    const basic = Buffer.from(`:${pat.trim()}`).toString("base64");
    cached = { header: `Basic ${basic}`, source: "pat-env" };
    return cached;
  }

  let token: string;
  try {
    token = await run("az", [
      "account",
      "get-access-token",
      "--resource",
      ADO_RESOURCE,
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ]);
  } catch {
    throw new Error(
      "No Azure DevOps credential. Set AZURE_DEVOPS_EXT_PAT, or run `az login` so " +
        "`az account get-access-token` can issue a token.",
    );
  }
  token = token.replace(/[\r\n]/g, "").trim();
  if (!token) throw new Error("az returned an empty access token; run `az login` again.");
  cached = { header: `Bearer ${token}`, source: "az-cli" };
  return cached;
}
