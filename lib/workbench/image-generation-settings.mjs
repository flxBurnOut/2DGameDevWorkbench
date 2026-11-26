import process from 'node:process';
import { readImageSettings, writeImageSettings } from './image-settings-store.mjs';

function currentProviderId(id) {
  return id === 'gpt-image-2.5' ? 'gpt-image-2.6' : id;
}

export function getPublicImageGenerationSettings(connector) {
  const saved = readImageSettings();
  const providers = readProviders(connector);
  const environmentProvider = readEnvironmentProvider(connector, providers);
  const environmentProviderConfig = providers.find((provider) => provider.id === environmentProvider);
  const configuredEnvironmentProvider = environmentProviderConfig && resolveProviderApiKey(environmentProviderConfig, saved)
    ? environmentProvider
    : null;
  const activeProvider = saved.active === undefined
    ? configuredEnvironmentProvider
    : providers.find(provider => provider.id === currentProviderId(saved.active) && resolveProviderApiKey(provider, saved))?.id ?? null;
  const preferredProvider = activeProvider ?? providers.find(provider => provider.id === currentProviderId(saved.preferred))?.id ?? environmentProvider ?? connector.defaultProvider ?? providers[0]?.id ?? null;

  return {
    active: Boolean(activeProvider),
    provider: preferredProvider,
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      host: new URL(resolveProviderEndpoint(provider)).origin,
      model: provider.model,
      ...(provider.setupUrl ? { setupUrl: provider.setupUrl } : {}),
      ...(provider.usageNote ? { usageNote: provider.usageNote } : {}),
      configured: Boolean(resolveProviderApiKey(provider, saved)),
    })),
  };
}

export function updateImageGenerationSettings(connector, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('API settings must be a JSON object.');
  }
  if (Object.keys(input).some((key) => !['provider', 'active', 'apiKey'].includes(key))) {
    throw new Error('API settings contain an unsupported field.');
  }
  const providers = readProviders(connector);
  const provider = providers.find((candidate) => candidate.id === input.provider);
  if (!provider) throw new Error('API provider is invalid.');
  const saved = readImageSettings();
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string') throw new Error('API Key must be a string.');
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error('API Key cannot be empty.');
    validateImageApiKey(apiKey);
    saved.keys[provider.id] = apiKey;
  }
  if (input.active !== undefined && typeof input.active !== 'boolean') {
    throw new Error('active must be a boolean.');
  }
  if (input.active === true && !resolveProviderApiKey(provider, saved)) {
    throw new Error(`Configure ${provider.name} API Key before activating it.`);
  }
  saved.preferred = provider.id;
  if (input.active === true) saved.active = provider.id;
  if (input.active === false) saved.active = null;
  // Validate public endpoint metadata before committing the update.
  providers.forEach(candidate => resolveProviderEndpoint(candidate));
  writeImageSettings(saved);

  return getPublicImageGenerationSettings(connector);
}

export function resolveImageGenerationProvider(connector, requestedProvider, operation = 'edit-image') {
  const providers = readProviders(connector);
  const publicSettings = getPublicImageGenerationSettings(connector);
  const providerId = requestedProvider ?? (publicSettings.active ? publicSettings.provider : null);
  if (!providerId) return null;
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error('API provider is invalid.');
  return {
    ...provider,
    endpoint: resolveProviderEndpoint(provider, operation),
    apiKey: resolveProviderApiKey(provider),
  };
}

function readProviders(connector) {
  if (!Array.isArray(connector?.providers) || connector.providers.length === 0) {
    throw new Error('Image generation providers are missing from the workbench manifest.');
  }
  return connector.providers.map((provider) => {
    if (
      !provider ||
      typeof provider.id !== 'string' ||
      typeof provider.name !== 'string' ||
      typeof provider.model !== 'string' ||
      typeof provider.protocol !== 'string' ||
      typeof provider.endpoint !== 'string' ||
      typeof provider.apiKeyEnv !== 'string'
    ) {
      throw new Error('Image generation provider metadata is invalid.');
    }
    return provider;
  });
}

function readEnvironmentProvider(connector, providers) {
  if (typeof connector?.providerEnv !== 'string') return null;
  const value = process.env[connector.providerEnv]?.trim();
  const provider = providers.find((candidate) => candidate.id === currentProviderId(value));
  return provider?.id ?? null;
}

function resolveProviderApiKey(provider, saved = readImageSettings()) {
  const shared = provider.credentialAliases?.map(id => saved.keys[id]).find(Boolean);
  return saved.keys[provider.id] ?? shared ?? process.env[provider.apiKeyEnv]?.trim() ?? '';
}

function resolveProviderEndpoint(provider, operation = 'edit-image') {
  const override = typeof provider.endpointEnv === 'string'
    ? process.env[provider.endpointEnv]?.trim()
    : '';
  let value = override || provider.endpoint;
  if (operation === 'generate-prop' && provider.protocol === 'openai-images-edits') {
    const generationOverride = process.env[provider.generationEndpointEnv]?.trim();
    if (generationOverride) value = generationOverride;
    else if (override) {
      const target = new URL(override);
      if (!target.pathname.endsWith('/edits')) throw new Error('自定义图片地址需要配置 MAP_STITCHER_OPENAI_GENERATION_API_URL，或使用以 /edits 结尾的地址。');
      target.pathname = target.pathname.replace(/\/edits$/, '/generations');
      value = target.toString();
    } else value = provider.generationEndpoint;
  }
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password) {
    throw new Error(`${provider.name} endpoint must not contain credentials.`);
  }
  if (endpoint.protocol !== 'https:' && !isLoopbackHttp(endpoint)) {
    throw new Error(`${provider.name} endpoint must use HTTPS.`);
  }
  return endpoint.toString();
}

function isLoopbackHttp(endpoint) {
  return endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname);
}

export function validateImageApiKey(apiKey) {
  if (apiKey.length > 4096) throw new Error('API Key is too long.');
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('图片 API 密钥格式无效：请仅粘贴密钥，不要包含中文说明、空格或换行。请在生成设置中重新填写。');
  }
}
