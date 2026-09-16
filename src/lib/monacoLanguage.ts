/**
 * 文件路径 → Monaco 语言 id。
 *
 * 语言 id 必须取自 Monaco 实际注册的语言,写错不会报错,只会静默退化成纯文本高亮。
 * 下面的集合来自 monaco-editor@0.56 的 `esm/vs/languages/definitions/`(81 种 basic
 * language)加四个带语言服务的 `esm/vs/language/`(json / css / html / typescript)。
 *
 * 已知缺口(Monaco 没有对应语言,保持纯文本):toml、vue、svelte、cmake、make。
 * 其中 `.toml` 归到 `ini` —— 分节 + `key = value` 与 INI 形似,比纯文本可读,但它
 * 只是近似,不是真正的 TOML 语法。
 */

/** 无扩展名或扩展名不足以判断时的整名匹配(小写)。 */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.profile': 'shell',
  '.kshrc': 'shell',
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  abap: 'abap',
  apex: 'apex',
  azcli: 'azcli',
  bat: 'bat',
  bicep: 'bicep',
  c: 'c',
  cc: 'cpp',
  clj: 'clojure',
  cljs: 'clojure',
  cls: 'apex',
  cmd: 'bat',
  coffee: 'coffee',
  cpp: 'cpp',
  cs: 'csharp',
  csh: 'shell',
  csp: 'csp',
  css: 'css',
  cxx: 'cpp',
  cy: 'cypher',
  cyp: 'cypher',
  dart: 'dart',
  ecl: 'ecl',
  ex: 'elixir',
  exs: 'elixir',
  flow: 'flow9',
  fs: 'fsharp',
  fsx: 'fsharp',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hbs: 'handlebars',
  hcl: 'hcl',
  hh: 'cpp',
  hpp: 'cpp',
  hrl: 'plaintext',
  hs: 'plaintext',
  htm: 'html',
  html: 'html',
  hxx: 'cpp',
  ini: 'ini',
  java: 'java',
  jl: 'julia',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  ksh: 'shell',
  less: 'less',
  liquid: 'liquid',
  lua: 'lua',
  m3: 'm3',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'javascript',
  mts: 'typescript',
  mysql: 'mysql',
  pas: 'pascal',
  patch: 'plaintext',
  pgsql: 'pgsql',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  proto: 'protobuf',
  ps1: 'powershell',
  psm1: 'powershell',
  pug: 'pug',
  py: 'python',
  pyw: 'python',
  qs: 'qsharp',
  r: 'r',
  razor: 'razor',
  rb: 'ruby',
  redis: 'redis',
  rest: 'restructuredtext',
  rs: 'rust',
  rst: 'restructuredtext',
  sass: 'scss',
  sb: 'sb',
  scala: 'scala',
  scss: 'scss',
  sh: 'shell',
  sol: 'solidity',
  sparql: 'sparql',
  sql: 'sql',
  st: 'st',
  sv: 'systemverilog',
  swift: 'swift',
  tcl: 'tcl',
  tex: 'plaintext',
  tf: 'hcl',
  tfvars: 'hcl',
  toml: 'ini',
  ts: 'typescript',
  tsv: 'plaintext',
  tsx: 'typescript',
  twig: 'twig',
  txt: 'plaintext',
  typespec: 'typespec',
  vb: 'vb',
  wgsl: 'wgsl',
  xhtml: 'html',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

/**
 * 解析文件路径对应的 Monaco 语言 id。识别不出来返回 `plaintext`
 * (Monaco 的通用兜底语言),而不是 undefined,调用方不必再兜一层。
 */
export function resolveMonacoLanguage(filePath?: string | null): string {
  if (!filePath) {
    return 'plaintext';
  }

  // 同时接受 Windows 反斜杠与 POSIX 正斜杠路径。
  const segments = filePath.split(/[\\/]/);
  const basename = (segments[segments.length - 1] ?? '').toLowerCase();
  if (!basename) {
    return 'plaintext';
  }

  const byName = FILENAME_LANGUAGES[basename];
  if (byName) {
    return byName;
  }

  // 末段无点(如 `LICENSE`)时没有扩展名可言。
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return 'plaintext';
  }

  return EXTENSION_LANGUAGES[basename.slice(dotIndex + 1)] ?? 'plaintext';
}
