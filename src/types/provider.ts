export enum Provider {
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  Google = 'google',
}

export enum ModelTier {
  Premium = 'premium',
  Standard = 'standard',
  Economy = 'economy',
  Images = 'images',
  Embeddings = 'embeddings',
}

export enum Capability {
  Chat = 'chat',
  Images = 'images',
  Embeddings = 'embeddings',
}

export interface ModelMapping {
  tier: ModelTier;
  capability: Capability;
  openai: string;
  anthropic: string | null;
  google: string | null;
}

// Bidirectional model mapping table
export const MODEL_MAPPINGS: ModelMapping[] = [
  // ── OpenAI gpt-4.1 family (April 2025) ──────────────────────────────────
  {
    tier: ModelTier.Premium,
    capability: Capability.Chat,
    openai: 'gpt-4.1',
    anthropic: 'claude-opus-4-6',
    google: 'gemini-1.5-pro',
  },
  {
    tier: ModelTier.Standard,
    capability: Capability.Chat,
    openai: 'gpt-4.1-mini',
    anthropic: 'claude-sonnet-4-6',
    google: 'gemini-1.5-flash',
  },
  {
    tier: ModelTier.Economy,
    capability: Capability.Chat,
    openai: 'gpt-4.1-nano',
    anthropic: 'claude-haiku-4-5',
    google: 'gemini-1.5-flash',
  },
  // ── OpenAI gpt-4o family ─────────────────────────────────────────────────
  {
    tier: ModelTier.Premium,
    capability: Capability.Chat,
    openai: 'gpt-4o',
    anthropic: 'claude-opus-4-6',
    google: 'gemini-1.5-pro',
  },
  {
    tier: ModelTier.Standard,
    capability: Capability.Chat,
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-6',
    google: 'gemini-1.5-flash',
  },
  {
    tier: ModelTier.Economy,
    capability: Capability.Chat,
    openai: 'gpt-3.5-turbo',
    anthropic: 'claude-haiku-4-5',
    google: 'gemini-1.5-flash',
  },
  // ── Claude 3.5 / 3 aliases (used by older Anthropic SDK versions) ────────
  {
    tier: ModelTier.Standard,
    capability: Capability.Chat,
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-20241022',
    google: 'gemini-1.5-flash',
  },
  {
    tier: ModelTier.Economy,
    capability: Capability.Chat,
    openai: 'gpt-3.5-turbo',
    anthropic: 'claude-3-5-haiku-20241022',
    google: 'gemini-1.5-flash',
  },
  {
    tier: ModelTier.Premium,
    capability: Capability.Chat,
    openai: 'gpt-4o',
    anthropic: 'claude-3-opus-20240229',
    google: 'gemini-1.5-pro',
  },
  {
    tier: ModelTier.Standard,
    capability: Capability.Chat,
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-sonnet-20240229',
    google: 'gemini-1.5-flash',
  },
  {
    tier: ModelTier.Images,
    capability: Capability.Images,
    openai: 'dall-e-3',
    anthropic: null, // not supported
    google: 'imagen-3.0-generate-001',
  },
  {
    tier: ModelTier.Embeddings,
    capability: Capability.Embeddings,
    openai: 'text-embedding-3-small',
    anthropic: null,
    google: null,
  },
  {
    tier: ModelTier.Embeddings,
    capability: Capability.Embeddings,
    openai: 'text-embedding-3-large',
    anthropic: null,
    google: null,
  },
  {
    tier: ModelTier.Embeddings,
    capability: Capability.Embeddings,
    openai: 'text-embedding-ada-002',
    anthropic: null,
    google: null,
  },
];

const MODEL_LOOKUP: Map<string, ModelMapping> = new Map();
for (const mapping of MODEL_MAPPINGS) {
  if (!MODEL_LOOKUP.has(mapping.openai)) MODEL_LOOKUP.set(mapping.openai, mapping);
  if (mapping.anthropic && !MODEL_LOOKUP.has(mapping.anthropic)) MODEL_LOOKUP.set(mapping.anthropic, mapping);
  if (mapping.google && !MODEL_LOOKUP.has(mapping.google)) MODEL_LOOKUP.set(mapping.google, mapping);
}

/**
 * Find the model mapping for any given model name (searches all providers)
 */
export function findModelMapping(modelName: string): ModelMapping | undefined {
  return MODEL_LOOKUP.get(modelName);
}

/**
 * Get the model name for a specific provider given any model name from any provider
 */
export function getModelForProvider(modelName: string, provider: Provider): string | null {
  const mapping = findModelMapping(modelName);
  if (!mapping) return null;

  switch (provider) {
    case Provider.OpenAI:
      return mapping.openai;
    case Provider.Anthropic:
      return mapping.anthropic;
    case Provider.Google:
      return mapping.google;
  }
}

/**
 * Get the capability for a given model name
 */
export function getCapabilityForModel(modelName: string): Capability {
  const mapping = findModelMapping(modelName);
  return mapping?.capability ?? Capability.Chat;
}
