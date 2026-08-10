import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCodexModelCatalogEntry,
  ensureCodexModelCatalog,
  isCodexModelAdvisoryError,
  isCodexNonFatalErrorItem,
  resolveCodexModelCatalogPath,
} from './codexModelCatalog.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('codexModelCatalog', () => {
  it('resolves the managed catalog under ~/.codex', () => {
    expect(resolveCodexModelCatalogPath('/tmp/home')).toBe(
      path.join('/tmp/home', '.codex', 'codemux-model-catalog.json'),
    );
  });

  it('builds a catalog entry with freeform apply_patch for custom models', () => {
    expect(buildCodexModelCatalogEntry('deepseek-v4-flash-free')).toMatchObject({
      slug: 'deepseek-v4-flash-free',
      display_name: 'Deepseek V4 Flash Free',
      apply_patch_tool_type: 'freeform',
      shell_type: 'shell_command',
      supported_in_api: true,
      context_window: 200000,
      max_context_window: 200000,
    });
  });

  it('builds a catalog entry with a custom context window', () => {
    expect(buildCodexModelCatalogEntry('custom-model', { contextWindow: 128000 })).toMatchObject({
      slug: 'custom-model',
      context_window: 128000,
      max_context_window: 128000,
    });
  });

  it('updates context window for an existing catalog slug', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codemux-catalog-'));
    tempDirs.push(dir);
    const catalogPath = path.join(dir, 'codemux-model-catalog.json');
    writeFileSync(catalogPath, JSON.stringify({
      models: [{
        slug: 'deepseek-v4-flash',
        display_name: 'Deepseek V4 Flash',
        base_instructions: 'keep me',
        context_window: 200000,
        max_context_window: 200000,
      }],
    }, null, 2));

    await ensureCodexModelCatalog(
      [{ id: 'deepseek-v4-flash', contextWindow: 200000 }],
      catalogPath,
    );

    const next = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      models: Array<{ slug: string; base_instructions?: string; context_window?: number; max_context_window?: number }>;
    };
    expect(next.models[0]?.base_instructions).toBe('keep me');
    expect(next.models[0]?.context_window).toBe(200000);
    expect(next.models[0]?.max_context_window).toBe(200000);
  });

  it('merges missing model slugs into an existing catalog file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codemux-catalog-'));
    tempDirs.push(dir);
    const catalogPath = path.join(dir, 'codemux-model-catalog.json');
    writeFileSync(catalogPath, JSON.stringify({
      models: [{
        slug: 'deepseek-v4-flash',
        display_name: 'Deepseek V4 Flash',
        base_instructions: 'keep me',
      }],
    }, null, 2));

    await ensureCodexModelCatalog(
      ['deepseek-v4-flash', 'deepseek-v4-flash-free'],
      catalogPath,
    );

    const next = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      models: Array<{ slug: string; base_instructions?: string }>;
    };
    expect(next.models.map((model) => model.slug)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-free',
    ]);
    expect(next.models[0]?.base_instructions).toBe('keep me');
  });

  it('treats Codex model advisories as non-fatal item errors', () => {
    expect(isCodexNonFatalErrorItem(
      'Model metadata for `deepseek-v4-flash` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    )).toBe(true);
    expect(isCodexModelAdvisoryError(
      'This session was recorded with model `deepseek-v4-flash` but is resuming with `deepseek-v4-flash-free`.',
    )).toBe(true);
  });
});
