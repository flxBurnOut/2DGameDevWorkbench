export class DocumentMediaCache {
  constructor(options: { store: { read: (key: string) => Promise<Blob | undefined>; write: (key: string, blob: Blob) => Promise<unknown> }; fetch?: typeof fetch; createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void });
  url(source: string): string;
  get(reference: string): Promise<{ blob: Blob; url: string; width?: number; height?: number }>;
  put(blob: Blob, mime: string): Promise<string>;
  compact<T>(kind: string, content: T): Promise<T>;
  hydrate<T>(kind: string, content: T): Promise<T>;
  dataUrl(source: string, mime: string): Promise<string>;
  publish(kind: string, content: unknown): Promise<void>;
  retain(scope: string, documents: Array<{ kind: string; content: unknown }>): void;
  release(scope: string): void;
}
