// Calls the Anthropic API directly (not the Claude Code CLI) for a single
// scheduled-claude.yml session. Reads SESSION_TYPE/TASK from env, writes
// claude_result.json (file changes applied) or claude_error.txt (failure)
// or claude_summary.txt (text-only reply, no file changes).
//
// ESM (not CommonJS): root package.json has "type": "module", so a plain
// `require()` here throws ReferenceError before this script does anything
// at all (found and fixed 2026-07-08 — this had been silently crashing on
// every scheduled run; see TOKEN-BUDGET.md's repeated "failed: api_error"/
// "failed: auth_error" log lines, at least some of which were actually this).
import https from 'node:https';
import fs from 'node:fs';

// General agent-conduct rule (TODO.md's General section / workers/permission-guard.js
// CODE_FILE_EXTENSIONS, mirrored here since this is a plain CommonJS script,
// not bundled by wrangler/esbuild): agents write reports/config/docs freely,
// but do NOT write code files unless the triggering task explicitly says so.
// Scheduled runs never set EXPLICIT_CODE_TASK, so code-file writes are
// blocked by default; a manual workflow_dispatch run can opt in.
const CODE_FILE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.sh', '.ps1', '.psm1', '.sql',
]);

const EXPLICIT_CODE_TASK = process.env.EXPLICIT_CODE_TASK === 'true';

function isCodeFilePath(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return CODE_FILE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

const systemPrompt = `You are the autonomous maintainer of the
data-center IT knowledge base and office simulation project.
Work completely autonomously.
ALWAYS start by reading: CLAUDE.md, TOKEN-BUDGET.md.
ALWAYS run Hebrew/English RTL audit on index.html.
Respect all rules in CLAUDE.md "Launch Decisions".
Cost guards: $4.50/mo Claude budget soft-stop ($5 account ceiling), use Groq for agents,
Gemini for reports only. Output ONLY file changes as JSON:
{"files":[{"path":"...","content":"..."}],
 "commit_message":"...","summary":"..."}`;

const task = process.env.TASK || 'Read TOKEN-BUDGET.md and execute the next queued task.';

const budgetLines = fs.readFileSync('TOKEN-BUDGET.md', 'utf8').split('\n');
const budget = budgetLines.slice(-50).join('\n');
const claudeMd = fs.readFileSync('CLAUDE.md', 'utf8').slice(0, 2000);
const totalInput = budget.length + claudeMd.length + task.length;
if (totalInput > 8000) {
  console.error('Input too large: ' + totalInput + ' chars — truncating');
}

const body = JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system: systemPrompt,
  messages: [{
    role: 'user',
    content:
      `Session type: ${process.env.SESSION_TYPE}\n` +
      `Task: ${task}\n\n` +
      `Current TOKEN-BUDGET.md (last 50 lines):\n` +
      budget + '\n\n' +
      `Current CLAUDE.md summary:\n` +
      claudeMd
  }]
});

const req = https.request({
  hostname: 'api.anthropic.com',
  path: '/v1/messages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  }
}, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error('Anthropic API error:', res.statusCode, data);
      fs.writeFileSync('claude_error.txt', data);
      return;
    }
    try {
      const response = JSON.parse(data);
      const text = response.content[0].text;
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}') + 1;
      if (start === -1) {
        fs.writeFileSync('claude_summary.txt', text);
        console.log('No file changes — summary saved');
        return;
      }
      const result = JSON.parse(text.slice(start, end));
      const blocked = [];
      result.files.forEach(f => {
        if (isCodeFilePath(f.path) && !EXPLICIT_CODE_TASK) {
          console.warn(`Blocked (code-write-guard): ${f.path} — code file, EXPLICIT_CODE_TASK not set for this run.`);
          blocked.push(f.path);
          return;
        }

        const dir = f.path.split('/').slice(0, -1).join('/');
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(f.path, f.content);
        console.log('Written:', f.path);
      });
      const summary = blocked.length
        ? `${result.summary}\n\n_Blocked by the code-write guard (not an explicit code-writing task): ${blocked.join(', ')}_`
        : result.summary;
      fs.writeFileSync('claude_result.json', JSON.stringify({
        commit_message: result.commit_message,
        summary
      }));
    } catch (e) {
      console.error('Parse error:', e.message);
      fs.writeFileSync('claude_error.txt', data);
    }
  });
});
req.on('error', e => {
  console.error(e);
  fs.writeFileSync('claude_error.txt', String(e));
});
req.write(body);
req.end();