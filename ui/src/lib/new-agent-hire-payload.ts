import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";

export function buildNewAgentHirePayload(input: {
  name: string;
  effectiveRole: string;
  title?: string;
  reportsTo?: string | null;
  selectedSkillKeys?: string[];
  instructionsGithubUrl?: string;
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
}) {
  const {
    name,
    effectiveRole,
    title,
    reportsTo,
    selectedSkillKeys = [],
    instructionsGithubUrl,
    configValues,
    adapterConfig,
  } = input;

  return {
    name: name.trim(),
    role: effectiveRole,
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
    ...(instructionsGithubUrl?.trim() ? { instructionsGithubUrl: instructionsGithubUrl.trim() } : {}),
    adapterType: configValues.adapterType,
    defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
    adapterConfig,
    runtimeConfig: buildNewAgentRuntimeConfig({
      heartbeatEnabled: configValues.heartbeatEnabled,
      intervalSec: configValues.intervalSec,
      cheapModel: configValues.cheapModel,
      cheapModelEnabled: configValues.cheapModelEnabled,
    }),
    budgetMonthlyCents: 0,
  };
}
