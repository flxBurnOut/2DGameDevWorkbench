import * as z from 'zod/v4';

export const modelProfileSchema = z
  .object({
    provider: z.enum(['openai', 'tokenhub']),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
    maxOutputTokens: z.number().int().min(1024).max(32768).default(12000),
    timeoutSeconds: z.number().int().min(30).max(600).default(180),
    tokenParameter: z
      .enum(['max_tokens', 'max_completion_tokens'])
      .default('max_tokens'),
    reasoningEffort: z.enum(['auto', 'low', 'medium', 'high', 'max']).default('auto'),
  })
  .strict();
