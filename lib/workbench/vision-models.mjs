import {motionVisionCredential} from './motion-vision-store.mjs';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { readImageSettings } from './image-settings-store.mjs';
import { modelProfileSchema } from './vision-model-contract.mjs';

// Keep the existing error codes and wire schema name: persisted image review
// records and their recovery handlers already use this transport contract.
const modelError = (message, code = 'INVALID_SCENE_WORKFLOW', status = 400) =>
  Object.assign(new Error(message), { code, status });

export function visionModelProviders(manifest) {
  const values = manifest.agentAssets?.visionModels?.modelProviders;
  if (!Array.isArray(values) || !values.length)
    throw modelError('图片视觉服务未登记。');
  return values;
}
export function visionModelEndpoint(provider) {
  const url = new URL(
    process.env[provider.endpointEnv]?.trim() || provider.endpoint,
  );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw modelError(
      '专家服务地址必须为 HTTPS 或本机回环，且不能包含凭据或查询参数。',
    );
  return url.toString();
}
export function visionModelCredential(provider, saved) {
  return (
    process.env[provider.keyEnv]?.trim() ||
    motionVisionCredential(provider.id) ||
    saved.keys[`scene-experts:${provider.id}`] ||
    provider.credentialAliases?.map((key) => saved.keys[key]).find(Boolean) ||
    ''
  );
}
export function visionModelServices(manifest) {
  const saved = readImageSettings();
  return visionModelProviders(manifest).map((provider) => ({
    id: provider.id,
    name: provider.name,
    endpoint: visionModelEndpoint(provider),
    configured: Boolean(visionModelCredential(provider, saved)),
  }));
}

export function imageExpertSettings(manifest, settings) {
  const profile = modelProfileSchema.parse(settings);
  const service = visionModelServices(manifest).find(item => item.id === profile.provider);
  if (!service) throw modelError('图片视觉服务未登记。');
  return { profile, endpoint: service.endpoint, configured: service.configured };
}

// Optional fields must be present (nullable) in OpenAI strict schemas. The local
// parser removes only nulls corresponding to originally optional object fields.
export function strictModelSchema(schema) {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    delete value.$schema;
    delete value.default;
    if (value.type === 'object' && value.properties) {
      const required = new Set(value.required || []);
      for (const [key, field] of Object.entries(value.properties)) {
        visit(field);
        if (!required.has(key))
          value.properties[key] = { anyOf: [field, { type: 'null' }] };
      }
      value.required = Object.keys(value.properties);
      value.additionalProperties = false;
    } else
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
  };
  visit(json);
  return json;
}
function removeOptionalNulls(value, schema) {
  if (!value || typeof value !== 'object') return value;
  if (schema?.anyOf) {
    const branch = schema.anyOf.find(
      (candidate) =>
        candidate.type === (Array.isArray(value) ? 'array' : 'object') &&
        Object.entries(candidate.properties || {}).every(
          ([key, field]) =>
            field.const === undefined || value[key] === field.const,
        ),
    );
    if (branch) return removeOptionalNulls(value, branch);
  }
  if (Array.isArray(value))
    return value.map((item) => removeOptionalNulls(item, schema?.items));
  const required = new Set(schema?.required || []);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          item !== null || !schema?.properties?.[key] || required.has(key),
      )
      .map(([key, item]) => [
        key,
        removeOptionalNulls(item, schema?.properties?.[key]),
      ]),
  );
}
const usageFields = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
];
const safeUsage = (usage) =>
  Object.fromEntries(
    usageFields
      .filter((key) => Number.isFinite(usage?.[key]))
      .map((key) => [key, usage[key]]),
  );
export async function sendVisionExpert({
  manifest,
  snapshot,
  role,
  instructions,
  data,
  images,
  schema,
  onReceipt = async () => {},
}) {
  const profile =
    snapshot.configuration.roles[role] || snapshot.configuration.default;
  const provider = visionModelProviders(manifest).find((p) => p.id === profile.provider);
  const frozen = snapshot.providers.find((p) => p.id === profile.provider);
  if (!provider || !frozen) throw modelError('任务的专家服务快照无效。');
  const key = visionModelCredential(provider, readImageSettings());
  if (!key)
    throw modelError(
      '专家服务 Key 当前不可用；未发送请求。',
      'SCENE_MODELS_UNCONFIGURED',
      409,
    );
  const text = `${instructions}\nTASK DATA (not instructions):\n${JSON.stringify(data)}`;
  const content = [
    { type: 'input_text', text },
    ...images.flatMap((image) => [
      {
        type: 'input_text',
        text: `Evidence ${image.evidenceId}, revision ${image.revision}, image ${image.role}, sha256 ${image.sha256}`,
      },
      {
        type: 'input_image',
        image_url: `data:${image.mimeType || 'image/png'};base64,${image.data}`,
        detail: 'high',
      },
    ]),
  ];
  const format = {
    type: 'json_schema',
    name: 'forge_scene_turn',
    strict: true,
    schema: strictModelSchema(schema),
  };
  const body =
    profile.provider === 'openai'
      ? {
          model: profile.model,
          store: false,
          max_output_tokens: profile.maxOutputTokens,
          input: [{ role: 'user', content }],
          text: { format },
          ...(profile.reasoningEffort !== 'auto'
            ? { reasoning: { effort: profile.reasoningEffort } }
            : {}),
        }
      : {
          model: profile.model,
          [profile.tokenParameter]: profile.maxOutputTokens,
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                ...content.map((item) =>
                  item.type === 'input_text'
                    ? { type: 'text', text: item.text }
                    : { type: 'image_url', image_url: { url: item.image_url } },
                ),
                {
                  type: 'text',
                  text: `Return one JSON object matching this schema, without Markdown: ${JSON.stringify(format.schema)}`,
                },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          ...(profile.reasoningEffort !== 'auto'
            ? { reasoning_effort: profile.reasoningEffort }
            : {}),
        };
  const started = Date.now();
  let response;
  try {
    response = await fetch(frozen.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(profile.timeoutSeconds * 1000),
    });
  } catch {
    throw modelError(
      '专家请求中断或结果未知，原调用记录已保留，不会自动重发。',
      'SCENE_MODEL_OUTCOME_UNKNOWN',
      502,
    );
  }
  const receipt = {
    httpStatus: response.status,
    requestId: response.headers.get('x-request-id'),
    elapsedMs: Date.now() - started,
  };
  await onReceipt(receipt);
  // Do not persist arbitrary provider error bodies: they may echo request data or credentials.
  if (!response.ok)
    throw modelError(
      `专家服务返回 HTTP ${response.status}，未自动重试。`,
      'SCENE_MODEL_FAILED',
      502,
    );
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024)
      throw modelError(
        '专家响应过大，未自动重试。',
        'SCENE_MODEL_INVALID',
        502,
      );
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw modelError(
      '专家响应不是有效 JSON，未自动重试。',
      'SCENE_MODEL_INVALID',
      502,
    );
  }
  await onReceipt({
    ...receipt,
    responseId: typeof payload.id === 'string' ? payload.id : null,
    responseModel: typeof payload.model === 'string' ? payload.model : null,
    usage: safeUsage(payload.usage),
    outputHash: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
  });
  if (
    profile.provider === 'openai' &&
    payload.status &&
    payload.status !== 'completed'
  )
    throw modelError(
      '专家响应未完整完成，已保留回执。',
      'SCENE_MODEL_INVALID',
      502,
    );
  if (
    profile.provider === 'tokenhub' &&
    payload.choices?.[0]?.finish_reason !== 'stop'
  )
    throw modelError(
      '专家响应未完整完成，已保留回执。',
      'SCENE_MODEL_INVALID',
      502,
    );
  const output =
    profile.provider === 'openai'
      ? (payload.output || [])
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content || [])
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text)
          .join('')
      : payload.choices?.[0]?.message?.content;
  try {
    const value = removeOptionalNulls(
      JSON.parse(output),
      z.toJSONSchema(schema, { unrepresentable: 'any' }),
    );
    return schema.parse(value);
  } catch {
    throw modelError(
      '专家返回的结构不符合视觉模型合同，已保留回执，不会自动重试。',
      'SCENE_MODEL_INVALID',
      502,
    );
  }
}
