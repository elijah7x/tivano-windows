// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shared provider metadata (frozen Provider.swift + ZaiRegion.swift port).
// Pure data only — no Node or DOM APIs.

import type { RuntimeMode } from "./types";

export type ProviderLaunchMode = "mock" | "synthetic-stdio" | "codex" | "zcode";
export type RegisteredProviderId = "codex" | "zcode";
export type ZaiRegion = "global" | "china";

export interface ZaiRegionMeta {
  readonly id: ZaiRegion;
  readonly title: string;
  readonly host: string;
  readonly apiHost: string;
  readonly apiKeySource: string;
  readonly keyPageUrl: string;
  readonly zcodeAccountProviderId: string;
}

export const ZAI_REGIONS: Record<ZaiRegion, ZaiRegionMeta> = {
  global: {
    id: "global",
    title: "Global",
    host: "api.z.ai",
    apiHost: "api.z.ai/api/coding/paas/v4",
    apiKeySource: "z.ai/manage-apikey/apikey-list",
    keyPageUrl: "https://z.ai/manage-apikey/apikey-list",
    zcodeAccountProviderId: "account:zai-individual-coding-plan",
  },
  china: {
    id: "china",
    title: "China",
    host: "open.bigmodel.cn",
    apiHost: "open.bigmodel.cn/api/coding/paas/v4",
    apiKeySource: "bigmodel.cn/usercenter/proj-mgmt/apikeys",
    keyPageUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    zcodeAccountProviderId: "account:bigmodel-individual-coding-plan",
  },
};

export function resolveZaiRegion(raw: unknown): ZaiRegion {
  return raw === "china" ? "china" : "global";
}

export interface ProviderMetadata {
  readonly id: RegisteredProviderId;
  readonly displayName: string;
  readonly agentName: string;
  readonly group: "agentCLI" | "tivanoCode";
  readonly accountLabel: string;
  readonly executableName: string;
  readonly installUrl: string;
  readonly supportsCompact: boolean;
  readonly supportsImages: boolean;
  readonly supportsRewind: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderMetadata[] = [
  {
    id: "codex",
    displayName: "Codex",
    agentName: "Codex CLI",
    group: "agentCLI",
    accountLabel: "ChatGPT plan or API key",
    executableName: "codex",
    installUrl: "https://developers.openai.com/codex/cli",
    supportsCompact: true,
    supportsImages: true,
    supportsRewind: true,
  },
  {
    id: "zcode",
    displayName: "ZCode",
    agentName: "ZCode CLI",
    group: "agentCLI",
    accountLabel: "GLM Coding Plan",
    executableName: "zcode",
    installUrl: "https://zcode.z.ai",
    supportsCompact: false,
    supportsImages: false,
    supportsRewind: false,
  },
];

export function providerMetadata(id: RegisteredProviderId): ProviderMetadata {
  return PROVIDER_CATALOG.find((p) => p.id === id)!;
}

export function providerSupportsRuntimeMode(
  _id: RegisteredProviderId,
  _mode: RuntimeMode,
): boolean {
  return true;
}
