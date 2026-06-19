# Quick Start (30 Seconds)

## The 5-Minute Setup

### 1. Upgrade Your Project
```bash
webdev_add_feature(brief, feature="web-db-user")
```

### 2. Define Your Tables
Edit `drizzle/schema.ts`:
```typescript
export const todos = mysqlTable("todos", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  done: boolean("done").default(false),
  createdAt: timestamp("createdAt").defaultNow(),
});
```

### 3. Create Query Helpers
Edit `server/db.ts`:
```typescript
export async function createTodo(userId: number, title: string) {
  const db = await getDb();
  await db.insert(todos).values({ userId, title });
  return await db.select().from(todos).where(eq(todos.userId, userId)).limit(1);
}
```

### 4. Build API
Edit `server/routers.ts`:
```typescript
todo: router({
  create: protectedProcedure
    .input(z.object({ title: z.string() }))
    .mutation(({ input, ctx }) => db.createTodo(ctx.user.id, input.title)),
  
  list: protectedProcedure
    .query(({ ctx }) => db.getTodos(ctx.user.id)),
}),
```

### 5. Use in React
```typescript
function TodoList() {
  const { data: todos } = trpc.todo.list.useQuery();
  const create = trpc.todo.create.useMutation();
  
  return (
    <div>
      {todos?.map(t => <div key={t.id}>{t.title}</div>)}
      <button onClick={() => create.mutate({ title: "New" })}>Add</button>
    </div>
  );
}
```

## That's It! 🎉

You now have a working database with:
- ✅ Persistent storage
- ✅ Type-safe API
- ✅ User authentication
- ✅ Real-time UI updates

## Next Steps

- **Learn More**: Read `guides/quick-start.md`
- **Advanced**: Check `workshops/multitenant-saas.md`
- **Examples**: Browse `examples/` folder
- **Deploy**: Follow `guides/deployment.md`

---

**Questions?** See `references/troubleshooting.md`
