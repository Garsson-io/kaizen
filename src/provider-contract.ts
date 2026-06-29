import { z } from 'zod';

export const AGENT_PROVIDER_VALUES = ['claude', 'codex'] as const;
export const AgentProviderSchema = z.enum(AGENT_PROVIDER_VALUES);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const SUBSCRIPTION_CLI_BILLING = 'subscription-cli' as const;
export type SubscriptionCliBilling = typeof SUBSCRIPTION_CLI_BILLING;

export interface SubscriptionAgentProvider {
  provider: AgentProvider;
  billing: SubscriptionCliBilling;
}

export function parseAgentProviderName(value: string): AgentProvider | null {
  const parsed = AgentProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function subscriptionAgentProvider(provider: AgentProvider): SubscriptionAgentProvider {
  return { provider, billing: SUBSCRIPTION_CLI_BILLING };
}

export function parseSubscriptionAgentProvider(value: string): SubscriptionAgentProvider | null {
  const provider = parseAgentProviderName(value);
  return provider ? subscriptionAgentProvider(provider) : null;
}
