import { describe, expect, it } from 'vitest';

import { loadFixture, measureLineCase, projectDiff, runEventCase, runSessionCase } from './artifactFixture.js';

/**
 * Shared-fixture conformance for the sidecar (live) implementation.
 * The Daemon (Rust) side runs the same fixture from the same file; see
 * `crates/daemon/src/agent/turn_artifact_summary.rs`.
 */

const fixture = loadFixture();

describe('artifact fixture — line-count semantics', () => {
  it('has cases', () => {
    expect(fixture.lineCases.length).toBeGreaterThan(0);
  });

  for (const lineCase of fixture.lineCases) {
    it(`line: ${lineCase.name}`, () => {
      expect(measureLineCase(lineCase)).toEqual({
        additions: lineCase.additions,
        deletions: lineCase.deletions,
      });
    });
  }
});

describe('artifact fixture — event sequences', () => {
  it('has cases', () => {
    expect(fixture.eventCases.length).toBeGreaterThan(0);
  });

  for (const eventCase of fixture.eventCases) {
    it(`events: ${eventCase.name}`, () => {
      expect(runEventCase(eventCase).map(projectDiff)).toEqual(eventCase.expectedDiffs);
    });
  }
});

describe('artifact fixture — whole sessions', () => {
  it('has cases', () => {
    expect(fixture.sessionCases.length).toBeGreaterThan(0);
  });

  for (const sessionCase of fixture.sessionCases) {
    it(`session: ${sessionCase.name}`, () => {
      const produced = runSessionCase(sessionCase).map((diffs) => diffs.map(projectDiff));
      expect(produced).toEqual(sessionCase.expectedSummaries.map((entry) => entry.diffs));
    });
  }
});
