/**
 * Model ID normalization — ported from Cherry Studio
 * `@cherrystudio/provider-registry` `utils/normalize.ts`.
 *
 * Keep behavior in lockstep with Cherry; prefer regenerating from upstream
 * rather than inventing local variants.
 */

export const COMMON_AGGREGATOR_PREFIXES = [
  'aihubmix-',
  'aihub-',
  'ahm-',
  'alicloud-',
  'azure-',
  'baidu-',
  'cbs-',
  'cc-',
  'sf-',
  's-',
  'bai-',
  'web-',
  'deepinfra-',
  'groq-',
  'nvidia-',
  'sophnet-',
  'zai-org-',
  'zai-',
  'lucidquery-',
  'lucidnova-',
  'lucid-',
  'siliconflow-',
  'chutes-',
  'huoshan-',
  'meta-',
  'cohere-',
  'coding-',
  'dmxapi-',
  'perplexity-',
  'ai21-',
  'openai-',
  'dmxapi_',
  'aistudio_',
] as const;

export const PREFIX_EXPANSIONS: ReadonlyArray<readonly [string, string]> = [['mm-', 'minimax-']];

export const COLON_VARIANT_SUFFIXES = [
  ':free',
  ':nitro',
  ':extended',
  ':beta',
  ':preview',
  ':thinking',
  ':exacto',
  ':latest',
  ':cloud',
] as const;

export const HYPHEN_VARIANT_SUFFIXES = [
  '-free',
  '-search',
  '-online',
  '-think',
  '-reasoning',
  '-classic',
  '-low',
  '-high',
  '-minimal',
  '-nothink',
  '-no-think',
  '-ssvip',
  '-thinking',
  '-nothinking',
  '-aliyun',
  '-huoshan',
  '-tee',
  '-cc',
  '-fw',
  '-di',
  '-t',
  '-reverse',
] as const;

export const PAREN_VARIANT_SUFFIXES = ['(free)', '(beta)', '(preview)', '(thinking)'] as const;

const PROTECTED_COMPOUND_PREFIXES = ['non', 'no', 'pre', 'anti', 'post'] as const;

const PARAMETER_SIZE_PATTERN = /-(\d+(?:\.\d+)?b)(?=-|$)/i;

const COLON_VARIANT_TAG_PATTERN = /^(?:\d+(?:[.x]\d+)*b(?:$|[-.])|q\d|iq\d|fp16|bf16|f16)/i;

export const QUANTIZATION_SUFFIXES = [
  '-fp8',
  '-fp16',
  '-bf16',
  '-awq',
  '-int4',
  '-int8',
  '-gguf',
  '-gptq',
] as const;

const DATE_SNAPSHOT_PATTERN =
  /-20\d{2}-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])$|-20\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$|-2\d(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$|-(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$|-2\d(?:0[1-9]|1[0-2])$/;

const BEDROCK_VENDOR = 'anthropic|amazon|meta|google|mistralai|cohere|openai|ai21|microsoft|nvidia';
const BEDROCK_DOTTED_VENDOR = `${BEDROCK_VENDOR}|deepseek|minimax|mistral|moonshot|moonshotai|qwen|writer|xai|zai`;
const BEDROCK_VENDOR_DOTTED = new RegExp(`^(?:[a-z]+\\.)*(?:${BEDROCK_DOTTED_VENDOR})\\.`);
const BEDROCK_VENDOR_DASH = new RegExp(`^(?:${BEDROCK_VENDOR})-{1,2}`);
const BEDROCK_REVISION_PATTERN = /(?:[-_]v?\d+)?:\d+$/i;

export function stripAggregatorPrefixes(modelId: string, additionalPrefixes: string[] = []): string {
  const allPrefixes = [...additionalPrefixes, ...COMMON_AGGREGATOR_PREFIXES];
  let result = modelId;

  for (const prefix of allPrefixes) {
    if (result.startsWith(prefix)) {
      result = result.slice(prefix.length);
      break;
    }
  }

  return result;
}

export function stripHostReprefix(modelId: string, isKnownId: (id: string) => boolean): string {
  const segs = modelId.split('-');
  for (let n = 1; n <= 2 && n < segs.length; n++) {
    const rest = segs.slice(n).join('-');
    if (isKnownId(rest)) return rest;
  }
  return modelId;
}

export function stripBedrockDottedVendorPrefix(modelId: string): string {
  return modelId.replace(BEDROCK_VENDOR_DOTTED, '');
}

export function stripBedrockVendorPrefix(modelId: string): string {
  return stripBedrockDottedVendorPrefix(modelId).replace(BEDROCK_VENDOR_DASH, '');
}

export function stripBedrockRevision(modelId: string): string {
  return modelId.replace(BEDROCK_REVISION_PATTERN, '');
}

export function expandKnownPrefixes(modelId: string): string {
  for (const [abbrev, canonical] of PREFIX_EXPANSIONS) {
    if (modelId.startsWith(abbrev)) {
      return canonical + modelId.slice(abbrev.length);
    }
  }
  return modelId;
}

export function stripVariantSuffixes(
  modelId: string,
  options: {
    colonSuffixes?: readonly string[];
    hyphenSuffixes?: readonly string[];
    parenSuffixes?: readonly string[];
    officialModelsWithSuffix?: Set<string>;
  } = {},
): string {
  const colonSuffixes = options.colonSuffixes ?? COLON_VARIANT_SUFFIXES;
  const hyphenSuffixes = options.hyphenSuffixes ?? HYPHEN_VARIANT_SUFFIXES;
  const parenSuffixes = options.parenSuffixes ?? PAREN_VARIANT_SUFFIXES;
  const officialModels = options.officialModelsWithSuffix ?? new Set<string>();

  if (officialModels.has(modelId)) {
    return modelId;
  }

  const colonIdx = modelId.lastIndexOf(':');
  if (colonIdx > 0) {
    const suffix = modelId.slice(colonIdx);
    if (colonSuffixes.includes(suffix)) {
      return modelId.slice(0, colonIdx);
    }
  }

  for (const suffix of hyphenSuffixes) {
    if (modelId.endsWith(suffix)) {
      const remaining = modelId.slice(0, -suffix.length);
      if (PROTECTED_COMPOUND_PREFIXES.some((p) => remaining === p || remaining.endsWith(`-${p}`))) {
        continue;
      }
      return remaining;
    }
  }

  for (const suffix of parenSuffixes) {
    if (modelId.endsWith(suffix)) {
      let result = modelId.slice(0, -suffix.length);
      if (result.endsWith(' ')) {
        result = result.slice(0, -1);
      }
      return result;
    }
  }

  return modelId;
}

export function normalizeVersionSeparators(modelId: string): string {
  return modelId.replace(/(\d)[,._p](?=\d)/g, '$1-');
}

export function stripQuantization(modelId: string): string {
  for (const suffix of QUANTIZATION_SUFFIXES) {
    if (modelId.endsWith(suffix)) {
      return modelId.slice(0, -suffix.length);
    }
  }
  return modelId;
}

export function stripDateSnapshot(modelId: string): string {
  return modelId.replace(/@.*$/, '').replace(DATE_SNAPSHOT_PATTERN, '');
}

export function stripVariantQuantDateSuffixes(modelId: string): string {
  let result = modelId;
  for (;;) {
    const next = stripDateSnapshot(stripQuantization(stripVariantSuffixes(result)));
    if (next === result) return result;
    result = next;
  }
}

export function stripParameterSize(modelId: string): string {
  return modelId.replace(PARAMETER_SIZE_PATTERN, '');
}

export function colonVariantTagToHyphen(modelId: string): string {
  const colonIdx = modelId.lastIndexOf(':');
  if (colonIdx > 0 && COLON_VARIANT_TAG_PATTERN.test(modelId.slice(colonIdx + 1))) {
    return `${modelId.slice(0, colonIdx)}-${modelId.slice(colonIdx + 1)}`;
  }
  return modelId;
}

export function normalizeModelId(modelId: string, options: { keepParameterSize?: boolean } = {}): string {
  const parts = modelId.split('/');
  let baseName = parts[parts.length - 1].toLowerCase();
  baseName = stripAggregatorPrefixes(baseName);
  baseName = stripBedrockVendorPrefix(baseName);
  baseName = stripBedrockRevision(baseName);
  baseName = expandKnownPrefixes(baseName);
  if (options.keepParameterSize) {
    baseName = colonVariantTagToHyphen(baseName);
  }
  for (;;) {
    const stripped = stripVariantQuantDateSuffixes(baseName);
    const next = options.keepParameterSize ? stripped : stripParameterSize(stripped);
    if (next === baseName) break;
    baseName = next;
  }
  baseName = normalizeVersionSeparators(baseName);
  baseName = baseName.replace(/_/g, '-');
  return baseName;
}
