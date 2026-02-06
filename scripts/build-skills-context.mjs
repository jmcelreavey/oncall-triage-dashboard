import { promises as fs } from 'fs';
import path from 'path';

const outPath = process.argv[2] || `${process.env.HOME}/.config/oncall-triage-dashboard/skills_context.md`;
const skillsDir = process.argv[3] || `${process.env.HOME}/.codex/skills`;

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      yield full;
    }
  }
}

const rows = [];
for await (const file of walk(skillsDir)) {
  const text = await fs.readFile(file, 'utf-8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) continue;
  const front = match[1];
  const name = front.match(/^name:\s*(.*)$/m)?.[1]?.trim();
  const desc = front.match(/^description:\s*(.*)$/m)?.[1]?.trim();
  if (!name && !desc) continue;
  rows.push({ name: name || '(unknown)', desc: desc || '', path: path.dirname(file) });
}

rows.sort((a, b) => a.name.localeCompare(b.name));

const lines = [
  '# Skills Context (auto-generated)',
  '',
  'This file lists available skills and short descriptions to guide the triage agent.',
  '',
  ...rows.map((r) => `- ${r.name}: ${r.desc} (path: ${r.path})`),
];

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, lines.join('\n'));
console.log(`Wrote skills context to ${outPath}`);
