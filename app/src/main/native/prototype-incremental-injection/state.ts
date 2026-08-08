export type Observation = 'pending' | 'correct' | 'wrong' | 'blocked' | 'ime-interference';

export interface TargetCase {
  id: string;
  label: string;
  dispatchAllowed: boolean;
}

export interface SampleCase {
  id: string;
  label: string;
  text: string;
}

export interface DispatchEvidence {
  acceptedEvents: number;
  expectedEvents: number;
  errorCode?: number;
  certainty: 'none-accepted' | 'os-accepted-all' | 'ambiguous-partial';
  recovery: 'clipboard-fallback-safe' | 'do-not-retry' | 'halt-automatic-insertion';
}

export interface MatrixRow {
  targetId: string;
  sampleId: string;
  observation: Observation;
  evidence?: DispatchEvidence;
}

export interface PrototypeState {
  targetIndex: number;
  sampleIndex: number;
  halted: boolean;
  note: string;
  rows: MatrixRow[];
}

export type PrototypeAction =
  | { type: 'next-target'; targetCount: number }
  | { type: 'next-sample'; sampleCount: number }
  | { type: 'dispatch'; targetId: string; sampleId: string; evidence: DispatchEvidence }
  | { type: 'simulate-partial'; evidence: DispatchEvidence }
  | { type: 'observe'; targetId: string; sampleId: string; observation: Exclude<Observation, 'pending'> }
  | { type: 'reset-halt' };

export const initialState: PrototypeState = {
  targetIndex: 0,
  sampleIndex: 0,
  halted: false,
  note: 'Ready. Choose a target and sample, then dispatch.',
  rows: [],
};

export function interpretDispatch(
  acceptedEvents: number,
  expectedEvents: number,
  errorCode?: number
): DispatchEvidence {
  if (acceptedEvents === 0) {
    return {
      acceptedEvents,
      expectedEvents,
      errorCode,
      certainty: 'none-accepted',
      recovery: 'clipboard-fallback-safe',
    };
  }
  if (acceptedEvents === expectedEvents) {
    return {
      acceptedEvents,
      expectedEvents,
      errorCode,
      certainty: 'os-accepted-all',
      recovery: 'do-not-retry',
    };
  }
  return {
    acceptedEvents,
    expectedEvents,
    errorCode,
    certainty: 'ambiguous-partial',
    recovery: 'halt-automatic-insertion',
  };
}

function upsertRow(state: PrototypeState, next: MatrixRow): MatrixRow[] {
  const withoutCurrent = state.rows.filter(
    (row) => row.targetId !== next.targetId || row.sampleId !== next.sampleId
  );
  return [...withoutCurrent, next];
}

export function reducePrototype(
  state: PrototypeState,
  action: PrototypeAction
): PrototypeState {
  switch (action.type) {
    case 'next-target':
      return {
        ...state,
        targetIndex: (state.targetIndex + 1) % action.targetCount,
        note: 'Target changed.',
      };
    case 'next-sample':
      return {
        ...state,
        sampleIndex: (state.sampleIndex + 1) % action.sampleCount,
        note: 'Sample changed.',
      };
    case 'dispatch':
      return {
        ...state,
        halted: action.evidence.certainty === 'ambiguous-partial' || state.halted,
        note: `${action.evidence.certainty}; recovery=${action.evidence.recovery}`,
        rows: upsertRow(state, {
          targetId: action.targetId,
          sampleId: action.sampleId,
          observation: 'pending',
          evidence: action.evidence,
        }),
      };
    case 'simulate-partial':
      return {
        ...state,
        halted: true,
        note: `Synthetic ${action.evidence.certainty}; recovery=${action.evidence.recovery}. Matrix unchanged.`,
      };
    case 'observe': {
      const existing = state.rows.find(
        (row) => row.targetId === action.targetId && row.sampleId === action.sampleId
      );
      return {
        ...state,
        note: `Recorded ${action.observation}.`,
        rows: upsertRow(state, {
          targetId: action.targetId,
          sampleId: action.sampleId,
          observation: action.observation,
          evidence: existing?.evidence,
        }),
      };
    }
    case 'reset-halt':
      return { ...state, halted: false, note: 'Prototype halt reset manually.' };
  }
}
