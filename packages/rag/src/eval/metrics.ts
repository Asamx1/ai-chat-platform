import type { EvidenceAnchor, RetrievalUnit } from './types';

export type EvidenceMetrics = { evidenceHitRateAt5: number; evidenceCoverageAt5: number; evidenceMRRAt5: number; documentHitRateAt5: number };

/** Check a source-version span against an anchor, allowing different chunk boundaries. */
export function overlapsEvidence(unit: RetrievalUnit, anchor: EvidenceAnchor): boolean {
  return unit.origin !== 'WIKI' && unit.sourceDocumentId === anchor.sourceDocumentId &&
    unit.sourceVersionId === anchor.sourceVersionId &&
    unit.start !== undefined && unit.end !== undefined &&
    Number.isInteger(unit.start) && Number.isInteger(unit.end) && unit.end > unit.start &&
    unit.start < anchor.end && anchor.start < unit.end;
}

/** Compute four retrieval metrics on the first five units; each group accepts any equivalent anchor. */
export function calculateEvidenceMetrics(units: readonly RetrievalUnit[], anchors: readonly EvidenceAnchor[], groups: readonly (readonly number[])[]): EvidenceMetrics {
  const top = units.slice(0, 5);
  const covered = groups.map(group => top.some(unit => group.some(index => {
    const anchor = anchors[index];
    return anchor !== undefined && overlapsEvidence(unit, anchor);
  })));
  const first = top.findIndex(unit => groups.some(group => group.some(index => {
    const anchor = anchors[index];
    return anchor !== undefined && overlapsEvidence(unit, anchor);
  })));
  const correctDocuments = new Set(anchors.map(anchor => anchor.sourceDocumentId));
  return {
    evidenceHitRateAt5: covered.some(Boolean) ? 1 : 0,
    evidenceCoverageAt5: groups.length ? covered.filter(Boolean).length / groups.length : 0,
    evidenceMRRAt5: first < 0 ? 0 : 1 / (first + 1),
    documentHitRateAt5: top.some(unit => unit.origin !== 'WIKI' && correctDocuments.has(unit.sourceDocumentId)) ? 1 : 0,
  };
}
