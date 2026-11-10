import * as z from 'zod/v4';

export const MAP_SPLIT_MAX_PIXELS = 64_000_000;
export const mapSplitIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const coordinate = z.number().int().min(0).max(30000);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const box = z
  .object({
    x: coordinate,
    y: coordinate,
    width: z.number().int().positive().max(30000),
    height: z.number().int().positive().max(30000),
  })
  .strict();
export const mapSplitSelectionSchema = z.lazy(() =>
  z.discriminatedUnion('type', [
    box.extend({ type: z.enum(['rect', 'rectangle']) }),
    z
      .object({
        type: z.literal('polygon'),
        points: z.array(point).min(3).max(10000),
      })
      .strict(),
    box.extend({
      type: z.literal('rle'),
      counts: z
        .array(z.number().int().nonnegative())
        .min(1)
        .max(MAP_SPLIT_MAX_PIXELS + 1),
    }),
    z
      .object({
        type: z.literal('alpha'),
        layerId: mapSplitIdSchema.optional(),
        threshold: z.number().int().min(1).max(255).default(1),
      })
      .strict(),
    z
      .object({
        type: z.literal('auto'),
        method: z.enum(['alpha', 'color']).default('color'),
        seed: point,
        bounds: box.optional(),
        layerId: mapSplitIdSchema.optional(),
        tolerance: z.number().int().min(0).max(255).default(32),
        connectivity: z.union([z.literal(4), z.literal(8)]).default(4),
      })
      .strict(),
    z
      .object({
        type: z.literal('combine'),
        operation: z.enum(['union', 'subtract', 'intersect']),
        selections: z.array(mapSplitSelectionSchema).min(1).max(1000),
      })
      .strict(),
    z
      .object({
        type: z.literal('sam'),
        box: box.optional(),
        points: z
          .array(point.extend({ include: z.boolean() }))
          .max(32)
          .default([]),
        window: box.optional(),
      })
      .strict(),
  ]),
);
export const mapSplitEdgeSchema = z
  .object({
    erode: z.number().int().min(0).max(8).default(0),
    feather: z.number().int().min(0).max(8).default(0),
    decontaminate: z
      .object({
        background: z.tuple([
          z.number().int().min(0).max(255),
          z.number().int().min(0).max(255),
          z.number().int().min(0).max(255),
        ]),
        strength: z.number().min(0).max(1).default(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export const mapSplitPartSpecSchema = z
  .object({
    id: mapSplitIdSchema.optional(),
    role: z.enum(['art', 'effect']).default('art'),
    plane: z.enum(['back', 'front']).default('back'),
    selection: mapSplitSelectionSchema,
    edge: mapSplitEdgeSchema.optional(),
  })
  .strict();
export const mapSplitSpecsSchema = z
  .array(
    z
      .object({
        id: mapSplitIdSchema,
        name: z.string().min(1).max(200),
        kind: z.enum(['object', 'background', 'surface']).default('object'),
        sourceKey: z.string().min(1).max(300).optional(),
        x: coordinate.optional(),
        y: coordinate.optional(),
        parts: z.array(mapSplitPartSpecSchema).min(1).max(128),
        collision: z
          .object({
            polygons: z.array(z.array(point).min(3).max(10000)).max(1000),
            mapIndices: z
              .array(z.number().int().nonnegative())
              .max(10000)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  )
  .max(4000);
export const MAP_SPLIT_SPEC_SCHEMA = z.toJSONSchema(mapSplitSpecsSchema, {
  unrepresentable: 'any',
});
