#!/usr/bin/env node
// Builds the plugin bundles from one source (README §agent-plugins), so the two cannot drift:
//
//   node scripts/build-plugins.mjs           write the generated files
//   node scripts/build-plugins.mjs --check   exit 1, naming each file, when a committed one differs from what it writes
//
// Inputs: package.json (name, version, description), scripts/plugins/source.json (metadata, the server, the Claude
// userConfig), skills/metabob/SKILL.md (the skill) and scripts/claude-plugin/edit-check.mjs (the edit check).
// Output:
//   - the Claude Code plugin in plugin/: .claude-plugin/plugin.json, .mcp.json (the server pinned to this exact
//     version, its environment from the userConfig), hooks/hooks.json (exec form: no shell, so no quoting with spaces
//     or on Windows), scripts/edit-check.mjs and skills/metabob/SKILL.md; and .claude-plugin/marketplace.json, which
//     lists it. plugin/ holds no package.json, so Claude Code runs no dependency install for it;
//   - the Agent Plugins 1.0 bundle at the repository root: plugin.json and mcp.json (the same pinned server, no
//     environment: 1.0 has no secrets, so the key comes from the config file), beside the skill in skills/; and
//     .agents/plugins/marketplace.json, the Codex marketplace, which lists the root.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const AGENT_PLUGINS = 'https://agent-plugins.org/schemas/1.0.0';

export function generate() {
  const pkg = JSON.parse(read('package.json'));
  const src = JSON.parse(read('scripts/plugins/source.json'));
  // npx resolves `npx <name>@<version>` to the local project when the working directory's package.json has that name
  // and version, which a checkout of this repository has, and a plugin cache is one (Codex starts the server in it):
  // the command then fails (`sh: mcp: not found`). An alias names a package no project is, so npx always fetches
  // the published one, from any directory.
  const launcher = { command: 'npx', args: ['-y', `--package=${src.server.alias}@npm:${src.server.package}@${pkg.version}`, src.server.bin] };

  const userConfig = Object.fromEntries(Object.entries(src.claude.userConfig).map(([key, { env: _env, ...field }]) => [key, field]));
  const claudeEnv = Object.fromEntries(Object.entries(src.claude.userConfig).map(([key, { env }]) => [env, `\${user_config.${key}}`]));
  const hook = (arg) => ({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/edit-check.mjs', arg], timeout: 10 });

  return {
    'plugin/.claude-plugin/plugin.json': json({
      name: src.name,
      version: pkg.version,
      description: pkg.description,
      author: src.author,
      homepage: src.homepage,
      repository: src.repository,
      license: src.license,
      keywords: src.keywords,
      hooks: './hooks/hooks.json',
      userConfig,
    }),
    'plugin/.mcp.json': json({ mcpServers: { [src.server.name]: { ...launcher, env: claudeEnv } } }),
    'plugin/hooks/hooks.json': json({
      description: "Before an agent's first edit of a file in a session, ask it to check what is known-wrong and in flight on that file (get_problems, path_activity). See scripts/edit-check.mjs.",
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [hook('pre')] }],
        PostToolUse: [{ matcher: 'mcp__.*metabob.*__(get_problems|path_activity)', hooks: [hook('post')] }],
      },
    }),
    'plugin/scripts/edit-check.mjs': read('scripts/claude-plugin/edit-check.mjs'),
    'plugin/skills/metabob/SKILL.md': read('skills/metabob/SKILL.md'),
    'plugin.json': json({
      $schema: `${AGENT_PLUGINS}/plugin.schema.json`,
      name: src.name,
      version: pkg.version,
      description: pkg.description,
      author: src.author,
      homepage: src.homepage,
      repository: src.repository,
      license: src.license,
      keywords: src.keywords,
    }),
    'mcp.json': json({ $schema: `${AGENT_PLUGINS}/mcp.schema.json`, mcpServers: { [src.server.name]: { type: 'stdio', ...launcher } } }),
    '.agents/plugins/marketplace.json': json({
      name: src.name,
      interface: { displayName: src.displayName },
      plugins: [{ name: src.name, source: { source: 'local', path: './' }, category: src.codexCategory }],
    }),
    '.claude-plugin/marketplace.json': json({
      name: src.name,
      owner: { name: src.author.name, url: src.author.url },
      metadata: { description: pkg.description },
      plugins: [{ name: src.name, source: './plugin', description: pkg.description, version: pkg.version, category: src.category, keywords: src.keywords }],
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = generate();
  if (process.argv.includes('--check')) {
    // Line endings aside: a Windows checkout may hold the committed files with CRLF.
    const same = (p, text) => existsSync(join(ROOT, p)) && readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n');
    const stale = Object.entries(files).filter(([p, text]) => !same(p, text)).map(([p]) => p);
    if (stale.length) {
      console.error(`build-plugins: ${stale.length} generated file(s) differ from their source; run \`node scripts/build-plugins.mjs\`:\n${stale.map((p) => `  ${p}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`build-plugins: ${Object.keys(files).length} generated files match their source`);
  } else {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(ROOT, p)), { recursive: true });
      writeFileSync(join(ROOT, p), text);
    }
    console.log(`build-plugins: wrote ${Object.keys(files).length} files`);
  }
}
