'use strict';
/* global module */

const QUESTION =
  'Does Electron utilityProcess provide enough measurable or lifecycle advantage over the existing main-owned stdio sidecar to justify migration?';

function createInitialState(runtime) {
  return {
    question: QUESTION,
    runtime,
    status: 'idle',
    activeCandidate: null,
    results: {},
    lastError: null,
  };
}

function reduce(state, action) {
  switch (action.type) {
    case 'started':
      return {
        ...state,
        status: action.status,
        activeCandidate: action.candidate,
        lastError: null,
      };
    case 'progress':
      return {
        ...state,
        status: action.status,
        activeCandidate: action.candidate,
      };
    case 'completed':
      return {
        ...state,
        status: 'idle',
        activeCandidate: null,
        results: {
          ...state.results,
          [action.candidate]: action.result,
        },
      };
    case 'failed':
      return {
        ...state,
        status: 'idle',
        activeCandidate: null,
        lastError: action.error,
      };
    case 'reset':
      return createInitialState(state.runtime);
    default:
      return state;
  }
}

module.exports = { QUESTION, createInitialState, reduce };
