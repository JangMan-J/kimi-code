import * as vscode from "vscode";

import {
  ensureKimiRegionMarker,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiRegionDetailed,
  type KimiRegionResolution,
} from "@moonshot-ai/kimi-code-oauth";
import { loadRuntimeConfigSafe, resolveConfigPath } from "@moonshot-ai/kimi-code-sdk";

export interface ExtensionRegionOptions {
  readonly homeDir: string;
  readonly configuredOAuthHost?: string;
  readonly configuredOAuthKey?: string;
}

export function readPersistedKimiOAuthRef(
  homeDir: string,
): { readonly key: string; readonly oauthHost?: string } | undefined {
  return loadRuntimeConfigSafe(resolveConfigPath({ homeDir })).config.providers?.[
    KIMI_CODE_PROVIDER_NAME
  ]?.oauth;
}

/**
 * Resolves the extension's region. On a remote extension host (Remote SSH,
 * dev container, Codespaces — the extension declares `extensionKind:
 * ["workspace"]`, so it runs on the remote machine) the local signals would
 * describe the server rather than the user's workstation, so inference and
 * marker persistence are skipped there and plain resolution is used instead.
 */
export function resolveExtensionRegion(options: ExtensionRegionOptions): KimiRegionResolution {
  const resolutionOptions = {
    configuredOAuthHost: options.configuredOAuthHost,
    configuredOAuthKey: options.configuredOAuthKey,
    homeDir: options.homeDir,
    readMarker: process.env["KIMI_CODE_REGION_MARKER"] !== "off",
  };
  if (vscode.env.remoteName !== undefined) {
    return resolveKimiRegionDetailed(resolutionOptions);
  }
  return ensureKimiRegionMarker(resolutionOptions);
}
