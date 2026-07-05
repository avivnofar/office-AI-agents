import os
import json
import requests
from datetime import datetime

GEMINI_KEY = os.environ["GEMINI_API_KEY"]
RESEND_KEY = os.environ["RESEND_API_KEY"]
ARCHIVE_PATH = "archive"
FROM_ADDRESS = "Smart Archive <onboarding@resend.dev>"

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
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
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
