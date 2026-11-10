export type Parameters = { fps?: number; loop?: boolean; definitionIds?: string[] };
export type Candidate = {
  id: string; kind: string; mapType?: string; label: string;
  status: 'editable' | 'material' | 'needs-input' | 'incomplete';
  recoverable: string[]; warnings: string[]; missing: string[];
  requiredParameters: { key: keyof Parameters; label: string }[];
  previewUrl?: string; frameCount?: number;
  metadata: { fps?: number; loop?: boolean; frameCount?: number; frameDurations?: number[] };
  objects?: { definitionId: string; displayName: string }[];
  duplicate?: { assetId: string; exact: boolean };
};
export type Inspection = { inspectionId: string; filename: string; expiresAt: string; candidates: Candidate[] };
export type Selection = { inspectionId: string; candidateId: string; parameters: Parameters };
export type Submission = { commandId: string; inspectionIds: string[]; selections: Selection[] };
export type Receipt = { commandId: string; status: 'completed'; assets: { id: string; label: string; viewPath: string; reused: boolean }[]; importedCount: number; reusedCount: number };
export const packageSelectionKey = (inspectionId: string, candidateId: string) => inspectionId + ':' + candidateId;
export function packageSelections(inspections: Inspection[], selected: string[], choices: Record<string, Parameters>): Selection[] {
  return inspections.flatMap(inspection => inspection.candidates.filter(candidate => selected.includes(packageSelectionKey(inspection.inspectionId, candidate.id)))
    .map(candidate => ({ inspectionId: inspection.inspectionId, candidateId: candidate.id, parameters: Object.fromEntries(candidate.requiredParameters.map(parameter => [parameter.key, choices[packageSelectionKey(inspection.inspectionId, candidate.id)]?.[parameter.key]])) })));
}
export function remainingPackageChoices(inspections: Inspection[], selected: string[], choices: Record<string, Parameters>, submission: Submission) {
  const completed = new Set(submission.selections.map(selection => packageSelectionKey(selection.inspectionId, selection.candidateId)));
  const remaining = inspections.map(inspection => ({ ...inspection, candidates: inspection.candidates.filter(candidate => !completed.has(packageSelectionKey(inspection.inspectionId, candidate.id))) })).filter(inspection => inspection.candidates.length);
  const remainingKeys = new Set(remaining.flatMap(inspection => inspection.candidates.map(candidate => packageSelectionKey(inspection.inspectionId, candidate.id))));
  return { inspections: remaining, selected: selected.filter(key => remainingKeys.has(key)), choices: Object.fromEntries(Object.entries(choices).filter(([key]) => remainingKeys.has(key))) };
}
