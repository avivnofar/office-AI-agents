---
name: database-integration
description: Add persistent database storage to web projects with full-stack integration. Use for adding database support to existing projects, building multi-table schemas, implementing user data persistence, or creating CRUD APIs with tRPC.
---

# Database Integration Skill

This skill guides you through adding comprehensive database support to web projects. It covers schema design, query helpers, tRPC APIs, and frontend integration.

## When to Use This Skill

Use this skill when you need to:

- **Add database to static site** - Upgrade from static to full-stack with persistent storage
- **Design multi-table schema** - Create normalized database structure for complex domains
- **Build CRUD APIs** - Implement create, read, update, delete operations with authorization
- **Persist user data** - Store user-generated content, preferences, or analytics
- **Enable real-time features** - Foundation for notifications, activity tracking, or live updates

## Prerequisites

- Active web project with server support (or ability to add web-db-user feature)
- Clear understanding of data models (what entities, fields, relationships)
- Basic familiarity with TypeScript and React

## Quick Start (30 minutes)

### 1. Upgrade Project
```bash
webdev_add_feature(brief, feature="web-db-user")
```

### 2. Define Schema
Edit `drizzle/schema.ts` using `templates/schema-template.ts` as reference:
- Replace `domainEntity` with your table names
- Add domain-specific fields and enums
- Define relationships with `relations()`

### 3. Create Helpers
Edit `server/db.ts` using `templates/db-helpers-template.ts`:
- Implement CRUD functions for each table
- Add filtering, sorting, pagination as needed
- Always check database availability

### 4. Build APIs
Edit `server/routers.ts` using `templates/routers-template.ts`:
- Create tRPC procedures for each operation
- Add input validation with Zod
- Verify user ownership before returning data

### 5. Use in Frontend
Call tRPC hooks from React components:
```typescript
const { data } = trpc.domainEntity.list.useQuery();
const mutation = trpc.domainEntity.create.useMutation();
```

## Detailed Workflow

For comprehensive step-by-step guidance, see `references/workflow.md`:

- **Phase 1:** Upgrade project to web-db-user
- **Phase 2:** Design database schema
- **Phase 3:** Create query helpers
- **Phase 4:** Build tRPC APIs
- **Phase 5:** Integrate with frontend

Estimated time: 2-4 hours for typical 3-5 table schema.

## Template Files

### `templates/schema-template.ts`
Database schema with:
- User table (core)
- Domain entity table (customize)
- Relations setup
- Type exports

**Usage:** Copy pattern to `drizzle/schema.ts`, replace with your tables.

### `templates/db-helpers-template.ts`
Query helpers with:
- Database connection management
- CRUD operations (create, read, update, delete)
- User-scoped queries
- Error handling

**Usage:** Extend `server/db.ts` with functions for each table.

### `templates/routers-template.ts`
tRPC routers with:
- Authentication patterns
- CRUD procedures
- Input validation (Zod)
- Authorization checks

**Usage:** Extend `server/routers.ts` with routers for each domain entity.

## Key Patterns

### Authorization
Always verify user ownership before returning data:
```typescript
if (!entity || entity.userId !== ctx.user.id) {
  throw new TRPCError({ code: "FORBIDDEN" });
}
```

### Nullable Fields
Handle optional fields correctly:
```typescript
values[field] = user[field] ?? null;  // Store undefined as NULL
```

### Mutations
After insert/update, fetch the complete record:
```typescript
await db.insert(table).values(data);
const result = await db.select().from(table).where(...).limit(1);
return result[0]!;
```

### Frontend Integration
Use optimistic updates for instant feedback:
```typescript
onMutate: (newData) => {
  queryClient.setQueryData(['list'], old => [...old, newData]);
},
onError: () => {
  queryClient.invalidateQueries(['list']);
},
```

## Common Scenarios

### Scenario 1: Add Database to Existing Project
1. Call `webdev_add_feature(brief, feature="web-db-user")`
2. Design schema in `drizzle/schema.ts`
3. Create helpers in `server/db.ts`
4. Build routers in `server/routers.ts`
5. Call tRPC hooks from React

### Scenario 2: Multi-Table System
1. List all entities and relationships
2. Create tables with foreign keys
3. Define relations for type-safe queries
4. Implement helpers with filtering/sorting
5. Build routers with pagination

### Scenario 3: User-Generated Content
1. Create content table with userId
2. Add timestamps (createdAt, updatedAt)
3. Implement user-scoped queries
4. Verify ownership in routers
5. Show user's content in UI

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `DATABASE_URL not found` | Env var not set; check project settings |
| Type errors in schema | Import types from `drizzle-orm/mysql-core` |
| Migration fails | Run `pnpm db:push` to apply schema |
| tRPC not responding | Verify `/api/trpc` route in server |
| Authorization errors | Check `ctx.user` is populated |
| Stale data in UI | Call `trpc.useUtils().invalidate()` |

## Next Steps

After completing database integration:

1. **Add validation** - Use Zod schemas for complex inputs
2. **Implement filtering** - Add category, status, date range filters
3. **Enable search** - Add full-text search on text fields
4. **Track analytics** - Log user actions and generate reports
5. **Add notifications** - Alert users of important events

## Resources

- **Drizzle ORM Docs:** https://orm.drizzle.team/
- **tRPC Docs:** https://trpc.io/
- **Zod Validation:** https://zod.dev/
- **MySQL Best Practices:** https://dev.mysql.com/doc/

## Support

For issues or questions:
- Check `references/workflow.md` for detailed guidance
- Review template files for patterns
- Test helpers with vitest before using in routers
- Verify database connection with `pnpm db:push`
