# Claude Code — Build the Architect Agent (daily research + summary email)

## Run this from: office-AI-agents (your existing repo)

```bash
cd office-AI-agents
```

This adds a new capability to your existing Office AI Agents system.
Do NOT touch the existing 11-agent simulation logic - this is additive.

---

## Confirmed settings for this build

- Schedule: 15:00 Israel time, Sunday-Thursday only
- Suggestion files live in: local-archive-galil-elion/docs/architect-suggestions/
- Email sender: reuse whatever "from" address is already used by the
  archive's own admin notifications - do not hardcode a guess

## Important - DST caveat, handle this explicitly

Israel is UTC+3 in summer (DST) and UTC+2 in winter. GitHub Actions
cron runs in UTC and does not auto-adjust. 15:00 Israel time today
(July, DST active) equals 12:00 UTC. This will silently shift to be
off by one hour when DST ends unless handled.

Schedule the workflow to run TWICE (12:00 UTC and 13:00 UTC), and have
the Python script check the actual current Israel local time, only
proceeding if it is genuinely 15:00 in Asia/Jerusalem - the "wrong"
trigger of the pair exits immediately without doing anything. This
self-corrects across DST changes with no manual maintenance twice a year.

---

## Task 1 - Find the archive's existing Resend from address

```bash
grep -n "from:" ../local-archive-galil-elion/api/notify-admin.js
```

Report the exact address found. Use this EXACT value as the sender in
this new automation.

---

## Task 2 - Create the workflow file

Create .github/workflows/archive-architect.yml:

```yaml
name: Archive Architect - Daily Research

on:
  schedule:
    - cron: '0 12 * * 0-4'
    - cron: '0 13 * * 0-4'
  workflow_dispatch: {}

jobs:
  research:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: avivnofar/local-archive-galil-elion
          path: archive
          token: ${{ secrets.ARCHIVE_REPO_TOKEN }}

      - name: Check if this is the correct Israel-time trigger and not weekend
        id: time_check
        run: |
          CURRENT_HOUR=$(TZ=Asia/Jerusalem date +%H)
          DAY=$(TZ=Asia/Jerusalem date +%u)
          if [ "$CURRENT_HOUR" != "15" ]; then
            echo "skip=true" >> $GITHUB_OUTPUT
          elif [ "$DAY" -eq 5 ] || [ "$DAY" -eq 6 ]; then
            echo "skip=true" >> $GITHUB_OUTPUT
          else
            echo "skip=false" >> $GITHUB_OUTPUT
          fi

      - name: Run Architect research
        if: steps.time_check.outputs.skip == 'false'
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
        run: |
          python3 agents/architect_agent.py

      - name: Commit suggestion file
        if: steps.time_check.outputs.skip == 'false'
        run: |
          cd archive
          git config user.name "Architect Agent"
          git config user.email "architect@noreply.github.com"
          git add docs/architect-suggestions/
          git commit -m "Architect suggestion for $(date +%Y-%m-%d)" || echo "Nothing to commit"
          git push
```

---

## Task 3 - Create the research agent script

Create agents/architect_agent.py:

```python
import os
import json
import requests
from datetime import datetime

GEMINI_KEY = os.environ["GEMINI_API_KEY"]
RESEND_KEY = os.environ["RESEND_API_KEY"]
ARCHIVE_PATH = "archive"
FROM_ADDRESS = "PASTE_THE_VERIFIED_FROM_ADDRESS_FROM_TASK_1_HERE"

def read_todo():
    path = f"{ARCHIVE_PATH}/GALIL_ELION_TODO.md"
    if not os.path.exists(path):
        return "No TODO file found."
    with open(path, encoding="utf-8") as f:
        return f.read()

def read_recent_log():
    path = f"{ARCHIVE_PATH}/PORT_LOG.md"
    if not os.path.exists(path):
        return "No PORT_LOG.md found."
    with open(path, encoding="utf-8") as f:
        return f.read()[-3000:]

def pick_task_and_research(todo_content, log_content):
    prompt = f"""You are the Architect, a planning agent for the Smart Archive project (Galil Elion regional archive).

Current TODO:
{todo_content}

Recent changelog:
{log_content}

Pick ONE reasonable task from the TODO to progress today. Consider what
is already done and what naturally follows. Write:
1. The name of the chosen task
2. Why this is a sensible choice today
3. A short executive summary in Hebrew (3-4 sentences) explaining the
   suggestion to Aviv, the project owner
4. A complete, ready-to-paste Claude Code session prompt in English,
   matching the structure and rigor of previous sessions in this
   project (diagnostic-first where relevant, clear verification steps,
   a changelog entry template, and hard rules at the end)

Return ONLY valid JSON, no markdown fences:
{{"task_name": "...", "reasoning": "...", "executive_summary": "...", "full_prompt": "..."}}"""

    response = requests.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        headers={"x-goog-api-key": GEMINI_KEY},
        json={"contents": [{"parts": [{"text": prompt}]}]},
        timeout=60
    )
    response.raise_for_status()
    text = response.json()["candidates"][0]["content"]["parts"][0]["text"]
    clean = text.replace("```json", "").replace("```", "").strip()
    return json.loads(clean)

def write_suggestion_file(result):
    date_str = datetime.now().strftime("%Y-%m-%d")
    folder = f"{ARCHIVE_PATH}/docs/architect-suggestions"
    os.makedirs(folder, exist_ok=True)
    filepath = f"{folder}/{date_str}.md"

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"# Architect Suggestion - {date_str}\n\n")
        f.write(f"## Task: {result['task_name']}\n\n")
        f.write(f"### Reasoning\n{result['reasoning']}\n\n")
        f.write(f"### Executive Summary\n{result['executive_summary']}\n\n")
        f.write(f"### Full Session Prompt\n\n```\n{result['full_prompt']}\n```\n")

    return filepath

def send_approval_email(result):
    html_body = f"""
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2 style="color:#4F46E5;">הצעת Architect להיום</h2>
      <p><strong>משימה:</strong> {result['task_name']}</p>
      <p>{result['executive_summary']}</p>
      <p style="font-size:13px;color:#666;">
        הפרומפט המלא נשמר בקובץ ב-docs/architect-suggestions/ בריפו של הארכיון.
        אין צורך באישור אוטומטי בשלב זה - זהו סיכום מחקר בלבד. אם תרצה
        להריץ את המשימה, פתח את הקובץ והדבק את הפרומפט ב-Claude Code בעצמך.
      </p>
      <p style="font-size:12px;color:#888;margin-top:16px;">
        לא נדרשת פעולה. הצעה זו תישאר זמינה ותתעדכן שוב מחר.
      </p>
    </div>
    """

    res = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_KEY}", "Content-Type": "application/json"},
        json={
            "from": FROM_ADDRESS,
            "to": "avivnofar@gmail.com",
            "subject": f"Architect: {result['task_name']}",
            "html": html_body
        },
        timeout=30
    )
    res.raise_for_status()

def main():
    todo = read_todo()
    log = read_recent_log()
    result = pick_task_and_research(todo, log)
    filepath = write_suggestion_file(result)
    send_approval_email(result)
    print(f"Suggestion written to {filepath}, email sent to avivnofar@gmail.com")

if __name__ == "__main__":
    main()
```

Replace FROM_ADDRESS with the exact value found in Task 1 before committing.

Note: this first version sends a research summary WITHOUT a functional
approve button yet - the button/webhook/Claude-API-code-generation
flow is a deliberately separate follow-up session, built only after
this research/email loop has run reliably for about a week. The email
body already explains this to Aviv.

---

## Task 4 - GitHub secrets

In office-AI-agents repo settings, under Secrets and variables,
Actions, confirm or add:
- ARCHIVE_REPO_TOKEN - create a NEW fine-grained PAT scoped only to
  local-archive-galil-elion with Contents Read and Write, expiring in
  90 days (set a calendar reminder to renew)
- GEMINI_API_KEY - reuse existing
- RESEND_API_KEY - reuse existing

Report which of these already existed vs needed to be created.

---

## Task 5 - Test run

Trigger manually to verify before waiting for the schedule:
```bash
gh workflow run archive-architect.yml
```

Or via GitHub UI: Actions tab, Archive Architect - Daily Research, Run workflow.

Confirm the workflow completes successfully, a new file appears in
local-archive-galil-elion/docs/architect-suggestions/, and an email
arrives at avivnofar@gmail.com.

---

## After completing all tasks

Commit and push:
```bash
git add -A
git commit -m "Add Architect Agent: daily research and suggestion email for Smart Archive"
git push origin main
```

---

## Report back

- Task 1: the exact from-address found and used
- Task 4: which secrets already existed vs were newly created
- Task 5: confirmation of a successful test run - the suggestion file content and confirmation the email arrived

---

## Hard rules

- Do not modify any existing Office AI Agents logic - this is purely additive
- Do not build the approve-button/code-generation flow yet - informational email only, this session
- Never hardcode the Israel-time DST offset as a single fixed UTC cron - use the dual-schedule-plus-runtime-check pattern above
- The GitHub token used must be scoped ONLY to local-archive-galil-elion, not a broader token
