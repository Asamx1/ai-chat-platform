import type { AssertionStatus } from './types';
export const legalTransitions: Readonly<Record<AssertionStatus, readonly AssertionStatus[]>> = {
  candidate: ['supported', 'contested', 'superseded', 'invalid'],
  supported: ['contested', 'superseded', 'invalid'],
  contested: ['supported', 'superseded', 'invalid'],
  superseded: ['invalid'], invalid: [],
};
export function canTransition(from: AssertionStatus, to: AssertionStatus): boolean {
  return legalTransitions[from].includes(to);
}
export function transitionStatus(from: AssertionStatus, to: AssertionStatus): AssertionStatus {
  if (!canTransition(from, to)) throw new Error(`Illegal assertion status transition: ${from} -> ${to}`);
  return to;
}
