# Workshop: Building a Multi-Tenant SaaS with Database Integration

**Duration:** 3-4 hours | **Difficulty:** Advanced | **Outcome:** Production-ready multi-tenant database

## Overview

This workshop guides you through building a complete multi-tenant SaaS application with proper data isolation, role-based access control, and scalable architecture.

## What You'll Build

A project management SaaS where:
- Multiple organizations (tenants) use the same application
- Each tenant's data is completely isolated
- Users have roles (admin, manager, member) with different permissions
- Projects, tasks, and team members are tenant-scoped
- Audit logs track all changes

## Prerequisites

- Completed basic database integration
- Understanding of foreign keys and relationships
- Familiarity with Zod validation
- Basic SQL knowledge helpful but not required

## Architecture Overview

```
organizations (tenants)
├── users (org members)
├── projects
│   ├── tasks
│   └── comments
├── team_members (with roles)
└── audit_logs
```

### Key Principles

1. **Tenant Isolation** - Every query filtered by organizationId
2. **Role-Based Access** - Users have roles within organizations
3. **Audit Trail** - All changes logged for compliance
4. **Soft Deletes** - Data marked deleted, not removed
5. **Timestamps** - Track creation and modification

---

## Phase 1: Design Multi-Tenant Schema

### Step 1: Create Organizations Table

```typescript
export const organizations = mysqlTable("organizations", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  description: text("description"),
  logo: varchar("logo", { length: 500 }),
  maxMembers: int("maxMembers").default(100),
  plan: mysqlEnum("plan", ["free", "pro", "enterprise"]).default("free"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
```

### Step 2: Create Organization Members Table

```typescript
export const organizationMembers = mysqlTable("organization_members", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", ["owner", "admin", "manager", "member"]).default("member"),
  joinedAt: timestamp("joinedAt").defaultNow().notNull(),
  invitedBy: int("invitedBy"),
  invitedAt: timestamp("invitedAt"),
  acceptedAt: timestamp("acceptedAt"),
});
```

### Step 3: Create Tenant-Scoped Tables

```typescript
export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", ["active", "archived", "deleted"]).default("active"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  deletedAt: timestamp("deletedAt"),
});

export const tasks = mysqlTable("tasks", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  projectId: int("projectId").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", ["todo", "in-progress", "done"]).default("todo"),
  priority: mysqlEnum("priority", ["low", "medium", "high", "urgent"]).default("medium"),
  assignedTo: int("assignedTo"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  dueDate: timestamp("dueDate"),
});
```

### Step 4: Create Audit Log Table

```typescript
export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  userId: int("userId").notNull(),
  action: varchar("action", { length: 100 }).notNull(), // "create", "update", "delete"
  entityType: varchar("entityType", { length: 50 }).notNull(), // "project", "task"
  entityId: int("entityId").notNull(),
  changes: json("changes").$type<Record<string, unknown>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

---

## Phase 2: Implement Query Helpers with Tenant Isolation

### Step 1: Create Organization Helpers

```typescript
export async function createOrganization(data: {
  name: string;
  slug: string;
  description?: string;
}): Promise<Organization> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(organizations).values({
    name: data.name,
    slug: data.slug,
    description: data.description,
  });

  const result = await db.select().from(organizations)
    .where(eq(organizations.slug, data.slug))
    .limit(1);
  
  return result[0]!;
}

export async function getOrganizationBySlug(slug: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  
  return result[0] || null;
}

export async function addMemberToOrganization(data: {
  organizationId: number;
  userId: number;
  role: "owner" | "admin" | "manager" | "member";
  invitedBy?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(organizationMembers).values({
    organizationId: data.organizationId,
    userId: data.userId,
    role: data.role,
    invitedBy: data.invitedBy,
    acceptedAt: new Date(),
  });
}
```

### Step 2: Create Tenant-Scoped Query Helpers

```typescript
export async function getProjectsByOrganization(organizationId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(projects)
    .where(and(
      eq(projects.organizationId, organizationId),
      ne(projects.status, "deleted")
    ))
    .orderBy(desc(projects.createdAt));
}

export async function getTasksByProject(organizationId: number, projectId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(tasks)
    .where(and(
      eq(tasks.organizationId, organizationId),
      eq(tasks.projectId, projectId)
    ))
    .orderBy(asc(tasks.dueDate));
}

export async function getUserOrganizations(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db.select({
    organization: organizations,
    role: organizationMembers.role,
  })
  .from(organizations)
  .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
  .where(eq(organizationMembers.userId, userId));
}
```

### Step 3: Create Audit Logging Helper

```typescript
export async function logAuditEvent(data: {
  organizationId: number;
  userId: number;
  action: "create" | "update" | "delete";
  entityType: string;
  entityId: number;
  changes?: Record<string, unknown>;
}) {
  const db = await getDb();
  if (!db) return;

  await db.insert(auditLogs).values({
    organizationId: data.organizationId,
    userId: data.userId,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId,
    changes: data.changes,
  });
}
```

---

## Phase 3: Build tRPC Routers with Authorization

### Step 1: Create Organization Router

```typescript
export const organizationRouter = router({
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const org = await db.createOrganization(input);
      
      // Add creator as owner
      await db.addMemberToOrganization({
        organizationId: org.id,
        userId: ctx.user.id,
        role: "owner",
      });

      // Log audit event
      await db.logAuditEvent({
        organizationId: org.id,
        userId: ctx.user.id,
        action: "create",
        entityType: "organization",
        entityId: org.id,
      });

      return org;
    }),

  getBySlug: protectedProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input, ctx }) => {
      const org = await db.getOrganizationBySlug(input.slug);
      if (!org) throw new TRPCError({ code: "NOT_FOUND" });

      // Verify user is member
      const member = await db.getOrganizationMember(org.id, ctx.user.id);
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      return org;
    }),
});
```

### Step 2: Create Authorization Helper

```typescript
export async function verifyOrganizationAccess(
  organizationId: number,
  userId: number,
  requiredRole?: "owner" | "admin" | "manager" | "member"
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const member = await db.select().from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, userId)
    ))
    .limit(1);

  if (!member[0]) return false;

  if (requiredRole) {
    const roleHierarchy = { owner: 4, admin: 3, manager: 2, member: 1 };
    const userRoleLevel = roleHierarchy[member[0].role as keyof typeof roleHierarchy] || 0;
    const requiredLevel = roleHierarchy[requiredRole] || 0;
    return userRoleLevel >= requiredLevel;
  }

  return true;
}
```

### Step 3: Create Protected Procedures

```typescript
const organizationProcedure = protectedProcedure
  .input(z.object({ organizationId: z.number() }))
  .use(async ({ ctx, input, next }) => {
    const hasAccess = await verifyOrganizationAccess(input.organizationId, ctx.user.id);
    if (!hasAccess) throw new TRPCError({ code: "FORBIDDEN" });
    return next({ ctx: { ...ctx, organizationId: input.organizationId } });
  });

const adminProcedure = organizationProcedure
  .use(async ({ ctx, input, next }) => {
    const hasAccess = await verifyOrganizationAccess(
      input.organizationId,
      ctx.user.id,
      "admin"
    );
    if (!hasAccess) throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  });

export const projectRouter = router({
  create: adminProcedure
    .input(z.object({
      organizationId: z.number(),
      name: z.string(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const project = await db.createProject({
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        createdBy: ctx.user.id,
      });

      await db.logAuditEvent({
        organizationId: input.organizationId,
        userId: ctx.user.id,
        action: "create",
        entityType: "project",
        entityId: project.id,
      });

      return project;
    }),

  list: organizationProcedure
    .query(async ({ input }) => {
      return await db.getProjectsByOrganization(input.organizationId);
    }),
});
```

---

## Phase 4: Frontend Integration

### Step 1: Create Organization Context

```typescript
import { createContext, useContext } from "react";
import { trpc } from "@/lib/trpc";

interface OrganizationContextType {
  organizationId: number;
  role: "owner" | "admin" | "manager" | "member";
}

const OrganizationContext = createContext<OrganizationContextType | null>(null);

export function OrganizationProvider({ organizationId, children }: any) {
  const { data: org } = trpc.organization.getBySlug.useQuery({ slug: organizationId });
  const userRole = org?.userRole || "member";

  return (
    <OrganizationContext.Provider value={{ organizationId, role: userRole }}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (!context) throw new Error("useOrganization must be used within OrganizationProvider");
  return context;
}
```

### Step 2: Use in Components

```typescript
function ProjectList() {
  const { organizationId } = useOrganization();
  const { data: projects } = trpc.project.list.useQuery({ organizationId });

  return (
    <div>
      {projects?.map(project => (
        <div key={project.id}>{project.name}</div>
      ))}
    </div>
  );
}
```

---

## Best Practices

1. **Always Filter by organizationId** - Every query must include organization isolation
2. **Verify Membership** - Check user is member before returning data
3. **Log Changes** - Create audit trail for compliance
4. **Use Soft Deletes** - Mark deleted instead of removing
5. **Role-Based Access** - Implement proper authorization
6. **Validate Ownership** - Verify user can access resource
7. **Handle Permissions** - Different roles have different capabilities

---

## Testing

```typescript
describe("Multi-Tenant Database", () => {
  it("isolates data between organizations", async () => {
    const org1 = await db.createOrganization({ name: "Org 1", slug: "org-1" });
    const org2 = await db.createOrganization({ name: "Org 2", slug: "org-2" });

    const project1 = await db.createProject({
      organizationId: org1.id,
      name: "Project 1",
      createdBy: 1,
    });

    const projects = await db.getProjectsByOrganization(org2.id);
    expect(projects).toHaveLength(0);
  });

  it("enforces role-based access", async () => {
    const hasAccess = await verifyOrganizationAccess(1, 1, "admin");
    expect(hasAccess).toBe(true);
  });
});
```

---

## Deployment Checklist

- [ ] All queries filter by organizationId
- [ ] Authorization checks on all mutations
- [ ] Audit logging for compliance
- [ ] Soft delete implementation
- [ ] Role hierarchy properly enforced
- [ ] Tests for data isolation
- [ ] Performance indexes on organizationId
- [ ] Database backups configured
