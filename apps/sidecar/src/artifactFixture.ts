import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { countDiffLines } from './diffStats.js';
import {
  synthesizeTurnArtifactSummaries,
  TurnArtifactAggregator,
  type SessionSummaryDiff,
} from './turnArtifactSummary.js';

/**
 * Reader for the repository-level shared fixture.
 *
 * The fixture is the single definition of "what correct looks like" for turn
 * artifact summarization, shared with the Daemon side (Rust). Both sides assert
 * against the same expected values, so a divergence between the two
 * implementations fails a test instead of reaching a user.
 *
 * The path is resolved by walking up from this file to the repository root
 * rather than via `process.cwd()`, so the suite behaves identically whether it
 * is run from the repo root or from `apps/sidecar`.
 */

const FIXTURE_RELATIVE_PATH = path.join('test-data', 'turn-artifact-summary', 'cases.json');

export interface LineCase {
  name: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export interface EventCase {
  name: string;
  cwd: string;
  events: Array<Record<string, unknown>>;
  expectedDiffs: SessionSummaryDiff[];
}

/**
 * A whole-timeline case, for behaviour that only exists at session level: how
 * many artifact cards a sequence of turns emits, and which of them are
 * synthesized versus already present in the timeline.
 *
 * Single-turn cases cannot express this, and the rule they miss is the one that
 * matters most: a turn that already carries a persisted summary must not be
 * given a second one when the timeline is loaded.
 */
export interface SessionCase {
  name: string;
  cwd: string;
  events: Array<Record<string, unknown>>;
  /** Expected artifact cards, in emission order. */
  expectedSummaries: Array<{ diffs: SessionSummaryDiff[] }>;
}

interface FixtureFile {
  lineCases: LineCase[];
  eventCases: EventCase[];
  sessionCases: SessionCase[];
}

function repositoryRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, FIXTURE_RELATIVE_PATH);
    try {
      readFileSync(candidate);
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(`shared fixture not found by walking up from ${import.meta.url}`);
}

let cached: FixtureFile | null = null;

export function loadFixture(): FixtureFile {
  if (!cached) {
    const file = path.join(repositoryRoot(), FIXTURE_RELATIVE_PATH);
    cached = JSON.parse(readFileSync(file, 'utf8')) as FixtureFile;
  }
  return cached;
}

/**
 * Project one produced diff entry onto the fields the fixture asserts.
 * `patch` is deliberately dropped: the two implementations disagree about
 * whether it is present (one fills it for patch tools, the other synthesizes
 * before/after), and it is not what the user sees.
 */
export function projectDiff(diff: SessionSummaryDiff): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    file: diff.file,
    additions: diff.additions ?? 0,
    deletions: diff.deletions ?? 0,
  };
  if (typeof diff.before === 'string') projected.before = diff.before;
  if (typeof diff.after === 'string') projected.after = diff.after;
  return projected;
}

export function runEventCase(eventCase: EventCase): SessionSummaryDiff[] {
  const aggregator = new TurnArtifactAggregator(eventCase.cwd);
  for (const event of eventCase.events) {
    aggregator.observe(event);
  }
  return aggregator.buildDiffs();
}

export function measureLineCase(lineCase: LineCase): { additions: number; deletions: number } {
  return countDiffLines(lineCase.before, lineCase.after);
}

/** Runs a whole-timeline case through the production session-level entry point. */
export function runSessionCase(sessionCase: SessionCase): SessionSummaryDiff[][] {
  const produced = synthesizeTurnArtifactSummaries(sessionCase.events, sessionCase.cwd);
  return produced
    .filter((event) => event.type === 'system_event' && event.subtype === 'session_summary')
    .map((event) => (event.diffs ?? []) as SessionSummaryDiff[]);
}
