# Database Integration Workflow

This guide walks through the complete process of adding persistent database storage to a web project.

## Overview

The database integration workflow consists of 5 phases:

1. **Upgrade Project** - Add web-db-user feature to enable database support
2. **Design Schema** - Define tables and relationships for your domain
3. **Create Helpers** - Write query functions for database operations
4. **Build APIs** - Implement tRPC procedures for CRUD operations
5. **Integrate Frontend** - Connect UI to database via tRPC hooks

**Estimated time:** 2-4 hours for a typical 3-5 table schema

---

## Phase 1: Upgrade Project to web-db-user

### Prerequisites
- Active web project with server support
- Clear understanding of data models needed

### Steps

1. **Call webdev_add_feature**
   ```
   webdev_add_feature(brief, feature="web-db-user")
   ```
   This adds:
   - Database connection infrastructure
   - Drizzle ORM setup
   - tRPC server configuration
   - Authentication context

2. **Verify Installation**
   - Check for `drizzle/` directory
   - Verify `server/db.ts` exists
   - Confirm `server/routers.ts` has auth router

### Outputs
- `drizzle/schema.ts` - Database schema file
- `server/db.ts` - Query helpers template
- `server/routers.ts` - tRPC routers template
- `drizzle.config.ts` - Drizzle configuration

---

## Phase 2: Design Schema

### Approach

1. **Identify Entities**
   - List all domain objects (e.g., incidents, tasks, posts)
   - For each entity, list required fields
   - Identify relationships (one-to-many, many-to-many)

2. **Use Templates**
   - Start with `schema-template.ts` from this skill
   - Replace `domainEntity` with actual table names
   - Add domain-specific fields and enums

3. **Define Relationships**
   - Use Drizzle relations for type-safe queries
   - Foreign keys link entities together
   - Relations enable eager loading

### Example: Incident Management System

```typescript
// Core tables
- users (id, openId, name, email, role)
- incidents (id, userId, title, description, category, status, severity)
- runbook_executions (id, userId, incidentId, command, output, success)
- knowledge_base (id, userId, title, content, category, isPublic)
- incident_timelines (id, incidentId, userId, events, rootCauseAnalysis)
```

### Best Practices

- **Keep tables normalized** - Avoid duplicating data
- **Use enums for fixed values** - status, category, role
- **Add timestamps** - createdAt, updatedAt on all tables
- **Include metadata JSON** - For flexible future fields
- **User ownership** - Most tables should have userId for access control

---

## Phase 3: Create Helpers (server/db.ts)

### Pattern

Each table gets a set of helper functions:

```typescript
// Create
export async function createEntity(data: CreateInput): Promise<Entity>

// Read
export async function getEntity(id: number): Promise<Entity | null>
export async function getEntitiesByUser(userId: number): Promise<Entity[]>

// Update
export async function updateEntity(id: number, data: Partial<Entity>): Promise<Entity | null>

// Delete
export async function deleteEntity(id: number): Promise<boolean>
```

### Key Principles

1. **Always check database availability**
   ```typescript
   const db = await getDb();
   if (!db) return null;
   ```

2. **Handle nullable fields carefully**
   - Use `?? null` for optional fields
   - Store undefined as database NULL

3. **Return full objects after mutations**
   - After insert/update, fetch the complete record
   - Ensures frontend gets latest data

4. **Use Drizzle query builders**
   - Type-safe queries
   - Automatic SQL generation
   - No manual SQL strings

### Testing Helpers

```typescript
// In server/*.test.ts
import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("db.createEntity", () => {
  it("creates entity with correct fields", async () => {
    const entity = await db.createEntity({
      userId: 1,
      title: "Test",
    });
    expect(entity.title).toBe("Test");
    expect(entity.userId).toBe(1);
  });
});
```

---

## Phase 4: Build APIs (server/routers.ts)

### Pattern

Each router follows CRUD + authorization:

```typescript
domainEntity: router({
  create: protectedProcedure
    .input(z.object({ /* fields */ }))
    .mutation(async ({ input, ctx }) => {
      return await db.createEntity({ userId: ctx.user.id, ...input });
    }),

  list: protectedProcedure
    .query(async ({ ctx }) => {
      return await db.getEntitiesByUser(ctx.user.id);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const entity = await db.getEntityById(input.id);
      if (!entity || entity.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return entity;
    }),

  update: protectedProcedure
    .input(z.object({ id: z.number(), /* fields */ }))
    .mutation(async ({ input, ctx }) => {
      // Verify ownership, then update
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      // Verify ownership, then delete
    }),
}),
```

### Authorization

- **protectedProcedure** - User must be logged in
- **publicProcedure** - Anyone can call
- **Check ownership** - Verify `entity.userId === ctx.user.id` before returning
- **Admin checks** - Use `ctx.user.role === "admin"` for admin-only operations

### Input Validation

Use Zod schemas for type-safe inputs:

```typescript
.input(z.object({
  title: z.string().min(1).max(255),
  category: z.enum(["a", "b", "c"]),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
}))
```

---

## Phase 5: Integrate Frontend

### Using tRPC Hooks

```typescript
// In React components
import { trpc } from "@/lib/trpc";

function MyComponent() {
  // Query data
  const { data, isLoading } = trpc.domainEntity.list.useQuery();

  // Mutate data
  const createMutation = trpc.domainEntity.create.useMutation();

  const handleCreate = async () => {
    const result = await createMutation.mutateAsync({
      title: "New Item",
    });
    // Invalidate cache to refetch
    trpc.useUtils().domainEntity.invalidate();
  };

  return (
    <div>
      {isLoading ? "Loading..." : data?.map(item => <div key={item.id}>{item.title}</div>)}
      <button onClick={handleCreate}>Create</button>
    </div>
  );
}
```

### Patterns

1. **Optimistic Updates** - Update UI before server response
   ```typescript
   onMutate: (newData) => {
     // Update cache immediately
     queryClient.setQueryData(['list'], old => [...old, newData]);
   },
   onError: () => {
     // Rollback on error
     queryClient.invalidateQueries(['list']);
   },
   ```

2. **Loading States** - Show spinners during operations
   ```typescript
   {createMutation.isPending && <Spinner />}
   ```

3. **Error Handling** - Display user-friendly messages
   ```typescript
   {createMutation.error && <Alert>{createMutation.error.message}</Alert>}
   ```

---

## Common Patterns

### Filtering & Sorting

```typescript
// In routers
export async function getEntitiesByCategory(userId: number, category: string) {
  const db = await getDb();
  return await db.select().from(entities)
    .where(and(
      eq(entities.userId, userId),
      eq(entities.category, category)
    ))
    .orderBy(desc(entities.createdAt));
}

// In tRPC
list: protectedProcedure
  .input(z.object({
    category: z.string().optional(),
    sortBy: z.enum(["recent", "popular"]).optional(),
  }))
  .query(async ({ input, ctx }) => {
    // Use input.category and input.sortBy to filter/sort
  }),
```

### Pagination

```typescript
list: protectedProcedure
  .input(z.object({
    page: z.number().default(1),
    limit: z.number().default(10),
  }))
  .query(async ({ input, ctx }) => {
    const offset = (input.page - 1) * input.limit;
    return await db.select().from(entities)
      .where(eq(entities.userId, ctx.user.id))
      .limit(input.limit)
      .offset(offset);
  }),
```

### Aggregations

```typescript
stats: publicProcedure.query(async () => {
  const db = await getDb();
  return await db.select({
    total: count(),
    byCategory: sql`COUNT(DISTINCT category)`,
  }).from(entities);
}),
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Database not connecting | Check DATABASE_URL env var is set |
| Type errors in schema | Ensure Drizzle types are imported |
| Migrations fail | Run `pnpm db:push` to apply schema changes |
| tRPC not working | Verify `/api/trpc` route exists in server |
| Authorization errors | Check `ctx.user` is populated in context |
| Stale data in UI | Call `trpc.useUtils().invalidate()` after mutations |
