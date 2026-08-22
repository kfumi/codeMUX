import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CODEX_MODEL_CATALOG_FILENAME = 'codemux-model-catalog.json';

type CodexCatalogModel = {
  slug: string;
  display_name: string;
  description: string;
  base_instructions: string;
  context_window: number;
  max_context_window: number;
  effective_context_window_percent: number;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  apply_patch_tool_type: string;
  supports_parallel_tool_calls: boolean;
  supports_reasoning_summaries: boolean;
  supports_search_tool: boolean;
  support_verbosity: boolean;
  default_verbosity: string;
  default_reasoning_level: string;
  default_reasoning_summary: string;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  input_modalities: string[];
  truncation_policy: { mode: string; limit: number };
  experimental_supported_tools: string[];
  additional_speed_tiers: unknown[];
  service_tiers: unknown[];
  model_messages: { instructions_template: string; instructions_variables: Record<string, string> };
  availability_nux: unknown;
  upgrade: unknown;
  web_search_tool_type: string;
  supports_image_detail_original: boolean;
  [key: string]: unknown;
};

type CodexCatalogFile = {
  models: CodexCatalogModel[];
};

const DEFAULT_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
];

/** Resolve the CodeMUX-managed Codex model catalog path under ~/.codex. */
export function resolveCodexModelCatalogPath(homeDir = homedir()): string {
  return path.join(homeDir, '.codex', CODEX_MODEL_CATALOG_FILENAME);
}

/** Build a complete valid ModelInfo entry for a custom model id. */
export function buildCodexModelCatalogEntry(
  modelId: string,
  options?: { contextWindow?: number; inputModalities?: string[] },
): CodexCatalogModel {
  const slug = modelId.trim();
  const displayName = formatCatalogDisplayName(slug);
  const contextWindow = normalizeContextWindow(options?.contextWindow);
  const inputModalities = normalizeInputModalities(options?.inputModalities);
  const supportsImage = inputModalities.includes('image');
  return {
    slug,
    display_name: displayName,
    description: displayName,
    base_instructions: 'You are Codex, a coding agent. Help the user complete tasks in their workspace.',
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1000,
    // NOTE: codex 0.146.x only accepts 'freeform' here ('function' makes
    // thread/resume fail with "unknown variant"). freeform emits a
    // Responses-API type:"custom" tool, which some third-party endpoints
    // (e.g. OpenRouter) reject — those providers need codex_needs_proxy.
    apply_patch_tool_type: 'freeform',
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    supports_search_tool: false,
    support_verbosity: true,
    default_verbosity: 'low',
    default_reasoning_level: 'medium',
    default_reasoning_summary: 'none',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
    input_modalities: inputModalities,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    service_tiers: [],
    model_messages: {
      instructions_template: 'You are Codex, a coding agent. Help the user complete tasks in their workspace.',
      instructions_variables: {},
    },
    availability_nux: null,
    upgrade: null,
    web_search_tool_type: 'text',
    supports_image_detail_original: supportsImage,
  };
}

/**
 * Ensure the given model ids exist in the CodeMUX Codex catalog file.
 * Existing richer entries are preserved; only missing slugs are appended.
 * When contextWindow / inputModalities are provided, those fields are updated.
 */
export async function ensureCodexModelCatalog(
  models: ReadonlyArray<string | { id: string; contextWindow?: number; inputModalities?: string[] }>,
  catalogPath = resolveCodexModelCatalogPath(),
): Promise<string | null> {
  const entries = normalizeCatalogInputs(models);
  if (entries.length === 0) {
    return null;
  }

  const existing = await readCatalogFile(catalogPath);
  const bySlug = new Map<string, CodexCatalogModel>();
  for (const model of existing.models) {
    if (typeof model?.slug === 'string' && model.slug.trim()) {
      bySlug.set(model.slug.trim(), model);
    }
  }

  let changed = false;
  for (const [slug, model] of bySlug) {
    const repaired = {
      ...buildCodexModelCatalogEntry(slug),
      ...model,
      slug,
      display_name: typeof model.display_name === 'string' && model.display_name.trim()
        ? model.display_name
        : formatCatalogDisplayName(slug),
    };
    if (JSON.stringify(repaired) !== JSON.stringify(model)) {
      bySlug.set(slug, repaired);
      changed = true;
    }
  }
  for (const entry of entries) {
    const existingEntry = bySlug.get(entry.id);
    if (!existingEntry) {
      bySlug.set(entry.id, buildCodexModelCatalogEntry(entry.id, {
        contextWindow: entry.contextWindow,
        inputModalities: entry.inputModalities,
      }));
      changed = true;
      continue;
    }

    let nextEntry = existingEntry;
    if (entry.contextWindow && entry.contextWindow > 0) {
      const contextWindow = normalizeContextWindow(entry.contextWindow);
      if (
        nextEntry.context_window !== contextWindow
        || nextEntry.max_context_window !== contextWindow
      ) {
        nextEntry = {
          ...nextEntry,
          context_window: contextWindow,
          max_context_window: contextWindow,
        };
      }
    }
    if (entry.inputModalities) {
      const inputModalities = normalizeInputModalities(entry.inputModalities);
      const supportsImage = inputModalities.includes('image');
      if (
        JSON.stringify(nextEntry.input_modalities ?? []) !== JSON.stringify(inputModalities)
        || nextEntry.supports_image_detail_original !== supportsImage
      ) {
        nextEntry = {
          ...nextEntry,
          input_modalities: inputModalities,
          supports_image_detail_original: supportsImage,
        };
      }
    }
    if (nextEntry !== existingEntry) {
      bySlug.set(entry.id, nextEntry);
      changed = true;
    }
  }

  if (changed || !existing.models.length) {
    const next: CodexCatalogFile = {
      models: [...bySlug.values()],
    };
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.writeFile(catalogPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  return catalogPath;
}

/**
 * Codex SDK ErrorItem is documented as non-fatal. Treat metadata / resume-model
 * advisories (and other item errors) as soft status, not turn failures.
 */
export function isCodexNonFatalErrorItem(message: string | null | undefined): boolean {
  if (typeof message !== 'string' || !message.trim()) {
    return false;
  }
  return true;
}

export function isCodexModelAdvisoryError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('model metadata')
    || normalized.includes('fallback metadata')
    || normalized.includes('was recorded with model')
    || normalized.includes('resuming with');
}

function formatCatalogDisplayName(modelId: string): string {
  return modelId
    .trim()
    .split(/[-_/.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export const DEFAULT_CODEX_CONTEXT_WINDOW = 200000;

function normalizeContextWindow(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_CODEX_CONTEXT_WINDOW;
}

function normalizeInputModalities(modalities?: string[]): string[] {
  const result = new Set<string>(['text']);
  for (const modality of modalities ?? []) {
    const normalized = modality.trim().toLowerCase();
    if (normalized && normalized !== 'text') {
      result.add(normalized);
    }
  }
  return Array.from(result);
}

function normalizeCatalogInputs(
  models: ReadonlyArray<string | { id: string; contextWindow?: number; inputModalities?: string[] }>,
): Array<{ id: string; contextWindow?: number; inputModalities?: string[] }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; contextWindow?: number; inputModalities?: string[] }> = [];
  for (const raw of models) {
    const id = typeof raw === 'string' ? raw.trim() : raw?.id?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const contextWindow = typeof raw === 'string' ? undefined : raw.contextWindow;
    const inputModalities = typeof raw === 'string' ? undefined : raw.inputModalities;
    result.push({
      id,
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      ...(inputModalities ? { inputModalities: normalizeInputModalities(inputModalities) } : {}),
    });
  }
  return result;
}

async function readCatalogFile(catalogPath: string): Promise<CodexCatalogFile> {
  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CodexCatalogFile>;
    if (!Array.isArray(parsed.models)) {
      return { models: [] };
    }
    return {
      models: parsed.models.filter(
        (model): model is CodexCatalogModel => Boolean(model && typeof model.slug === 'string'),
      ),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { models: [] };
    }
    process.stderr.write(`[codex] Failed to read model catalog at ${catalogPath}: ${String(error)}\n`);
    return { models: [] };
  }
}
