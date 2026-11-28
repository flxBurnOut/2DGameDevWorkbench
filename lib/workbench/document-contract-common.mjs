import * as z from 'zod/v4';

export const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const commandId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const coordinate = z.number().min(-1e7).max(1e7);
export const point = z.object({ x: coordinate, y: coordinate }).strict();
export const command = (type, fields = {}) => z.object({ type: z.literal(type), ...fields }).strict();
