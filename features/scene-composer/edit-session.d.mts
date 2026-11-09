import type { Scene } from './model.mjs';
import type { DocumentSavedSnapshot } from '../editor-documents/sync-controller.mjs';
import type { SharedDocument, DocumentResult } from '../editor-documents/client';
export type SceneSessionState = { phase: 'editing' | 'preview' | 'preparing' | 'candidate' | 'adopting' | 'history'; tool: string | null; canUndo: boolean; canRedo: boolean };
export type SceneAdoptionReceipt = { documentId: string; revision: number; currentRevision?: number; contentHash?: string };
export class SceneEditSession {
  constructor(options: { current(): Scene; fingerprint(scene: Scene): Promise<string>; saveLocal(): Promise<void>; flushSaved(): Promise<DocumentSavedSnapshot<Scene>>; readDocument(id: string, revision: number): Promise<DocumentResult<Scene>>; acceptAdopted(document: SharedDocument<Scene>, guard: DocumentSavedSnapshot<Scene>): Promise<DocumentSavedSnapshot<Scene>> });
  getState: () => SceneSessionState;
  subscribe: (listener: () => void) => () => void;
  guard: DocumentSavedSnapshot<Scene> | null;
  readonly blocksSync: boolean;
  readonly blocksEditing: boolean;
  preview(enabled: boolean): void;
  open(tool: string): Promise<DocumentSavedSnapshot<Scene>>;
  openReadOnly(tool: string): void;
  close(): void;
  check(): Promise<DocumentSavedSnapshot<Scene>>;
  accept(receipt: SceneAdoptionReceipt): Promise<DocumentSavedSnapshot<Scene>>;
  record(snapshot: Scene, adoption?: { revision: number; contentHash: string }): void;
  clearHistory(): void;
  travel(direction: 'undo' | 'redo', apply: (snapshot: Scene) => void | Promise<void>): Promise<void>;
}
