# Weekly Report — Week of {{week_start}}

## Aggregate metrics

| Agent | Cases solved | Avg mood | Irritation events | Happy events | Overtime days | Suggestions filed |
|-------|--------------|----------|--------------------|---------------|----------------|---------------------|
{{#each agents}}
| {{name}} | {{cases_solved}} | {{avg_mood}} | {{irritation_count}} | {{happy_count}} | {{overtime_days}} | {{suggestions_filed}} |
{{/each}}

## Incidents this week

{{#each incidents}}
- **{{agent_name}}** ({{severity}}): {{title}} — {{created_at}}
{{/each}}

## Suggestions queue (by permission level)

### Root

{{#each suggestions_root}}
- {{title}} ({{agent_name}})
{{/each}}

### Sudo

{{#each suggestions_sudo}}
- {{title}} ({{agent_name}})
{{/each}}

### Standard

{{#each suggestions_standard}}
- {{title}} ({{agent_name}})
{{/each}}

## Notes for next week

{{notes}}
