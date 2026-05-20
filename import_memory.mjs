import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = 'C:/Users/yucheng/Desktop/.claude/memory';
const API_URL = 'http://localhost:37777/api/memory/save';
const CWD = 'C:/Users/yucheng/Desktop/files';

// ASCII-safe JSON: escape all non-ASCII characters as \uXXXX
function safeStringify(obj) {
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, c =>
    `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`
  );
}

const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));

for (const file of files) {
  const filePath = join(MEMORY_DIR, file);
  const text = readFileSync(filePath, 'utf-8');

  const payload = safeStringify({ text, cwd: CWD, source: `legacy-memory/${file}` });

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: payload,
  });

  const json = await res.json();
  console.log(`${file} → ${json.success ? `✓ #${json.id}: ${json.title?.slice(0, 40)}` : `✗ ${json.error}`}`);
}
