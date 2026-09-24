// Pure contracts: intentionally no runtime imports.
export type AssertionStatus = 'candidate' | 'supported' | 'contested' | 'superseded' | 'invalid';
export interface ClassDefinition { id: string; label: string; description: string; abstract: boolean }
export interface RelationDefinition {
  id: string; label: string; description: string; domain: string[]; range: string[];
  symmetric: boolean; transitive: boolean; requiresContext: boolean; inverseOf?: string;
}
export interface Ontology {
  version: string; classes: ClassDefinition[]; endpointRoles: string[]; relations: RelationDefinition[];
  aliases: { fields: string[]; resolutionOrder: string[]; similarityMayMerge: false };
}
export interface Constraints {
  version: string; requiredFields: string[]; numericRequiredFields: string[];
  objectOrValue: 'exactlyOne'; origins: ['sourced', 'inferred'];
  endpointTypes: true; forbidSubclassCycles: true; evidenceTargetsAssertion: true;
}
export type RuleId = 'R-SUBCLASS-TRANS' | 'R-INVERSE-DECLARED' | 'R-SUPERSEDES-TRANS';
export interface InferenceRule { ruleId: RuleId; ruleVersion: string; description: string; premises: string[]; approved: true }
export interface InferenceRules { version: string; maxDepth: number; rules: InferenceRule[]; forbidden: string[] }
export interface Endpoint { id: string; type: string }
export interface Evidence { sourceId: string; sourceVersion: string; locator: string; excerpt: string; relation: 'supports' | 'contradicts' }
export interface Assertion {
  id: string; subject: Endpoint; predicate: string; object?: Endpoint; value?: string | number | boolean;
  polarity: 'positive' | 'negative'; context: Record<string, unknown>;
  validTime: { from: string | null; to: string | null }; status: AssertionStatus;
  evidence: Evidence[]; origin: 'sourced' | 'inferred'; ruleVersion: string; revision: number;
  unit?: string; dataset?: string; testSettings?: Record<string, unknown>; metric?: string;
  ruleId?: RuleId; premiseAssertionIds?: string[]; depth?: number; withdrawn?: boolean;
}
export interface Violation { code: string; path: string; message: string }
export interface InferenceOptions { ontology?: Ontology; maxDepth?: number; maxRounds?: number }
export interface InferenceResult {
  assertions: Assertion[]; derived: Assertion[];
  invalidateDerived(premiseId: string): Assertion[];
}
