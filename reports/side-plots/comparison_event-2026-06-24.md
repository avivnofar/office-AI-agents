# Comparison Event — started day 8

## Agents involved

- Agent 9
- Agent 6

## Timeline

Day 1: Agent compares Claude's answer to an externally-found answer; outcome (claude_better/external_better) recorded.
Day 2: If external_better: agent fileSuggestion()s a 'mock report' showing how easy the external answer was. If claude_better: agent's confidence in the app increases.
Day 3: Resolution: getModelUsageAdjustment() may nudge the agent's effective model_usage_rate (+/-0.05) based on the rolling win rate; QA (6) may pick up a strong external_better streak as an audit_session topic.

## Resolution

model_usage_rate delta applied via configOverrides; optionally seeds the next audit_session's agenda.
