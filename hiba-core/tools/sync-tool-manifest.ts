import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { toToolSpec } from '../packages/hiba-agent/src/core/defineTool';
import { allHibaTools } from '../packages/hiba-agent/src/tools/hiba.tools';

type OldEntry = {
  name: string;
  toolName?: string;
  scriptName?: string;
  renderHint?: string;
};

const manifestPath = resolve(__dirname, '..', '..', 'scripts_pi', 'deploy_http', 'scripts', 'manifest.json');
const current = JSON.parse(readFileSync(manifestPath, 'utf8')) as OldEntry[];
const tools = new Map(allHibaTools.map(tool => [tool.name, tool]));

const manifest = current.map(entry => {
  const toolName = entry.toolName ?? entry.name;
  const scriptName = entry.scriptName ?? (entry.toolName ? entry.name : undefined);
  const tool = tools.get(toolName as typeof allHibaTools[number]['name']);
  if (!tool || !scriptName) throw new Error(`No canonical ToolSpec or scriptName for '${toolName}'`);
  const scriptsDir = dirname(manifestPath);
  if (![resolve(scriptsDir, `${scriptName}.py`), resolve(scriptsDir, '..', `${scriptName}.py`)].some(existsSync)) {
    throw new Error(`Script artifact '${scriptName}.py' does not exist`);
  }
  return {
    scriptName,
    renderHint: entry.renderHint ?? 'table',
    ...toToolSpec(tool),
  };
});

const output = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(manifestPath, 'utf8') !== output) {
    throw new Error('Pi manifest is not synchronized; run npm run tools:sync');
  }
  console.log(`Tool manifest is synchronized (${manifest.length} entries)`);
} else {
  writeFileSync(manifestPath, output, 'utf8');
  console.log(`Wrote ${manifest.length} ToolSpec v1 entries to ${manifestPath}`);
}
