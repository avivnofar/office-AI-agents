import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { 
  InsertUser, 
  users,
  domainEntity,
  type DomainEntity,
  type InsertDomainEntity,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Lazily initialize database connection.
 * Allows local tooling to run without a DB.
 */
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * User Management
 */
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};

    // Handle nullable fields
    const textFields = ["name", "email", "loginMethod"] as const;
    textFields.forEach(field => {
      if (user[field] !== undefined) {
        values[field] = user[field] ?? null;
        updateSet[field] = user[field] ?? null;
      }
    });

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }

    // Promote owner to admin
    if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

/**
 * Domain Entity Operations (TEMPLATE)
 * Replace with your actual business logic.
 */
export async function createDomainEntity(data: {
  userId: number;
  title: string;
  description?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<DomainEntity> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(domainEntity).values({
    userId: data.userId,
    title: data.title,
    description: data.description,
    status: (data.status || "active") as any,
    metadata: data.metadata || {},
  });

  // Retrieve the newly created entity
  const allEntities = await db.select().from(domainEntity)
    .where(eq(domainEntity.userId, data.userId))
    .orderBy(desc(domainEntity.createdAt))
    .limit(1);
  
  return allEntities[0]!;
}

export async function getDomainEntities(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(domainEntity)
    .where(eq(domainEntity.userId, userId))
    .orderBy(desc(domainEntity.createdAt));
}

export async function getDomainEntityById(id: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(domainEntity).where(eq(domainEntity.id, id)).limit(1);
  return result[0] || null;
}

export async function updateDomainEntity(id: number, data: Partial<DomainEntity>) {
  const db = await getDb();
  if (!db) return null;

  await db.update(domainEntity).set(data).where(eq(domainEntity.id, id));
  return await getDomainEntityById(id);
}

export async function deleteDomainEntity(id: number) {
  const db = await getDb();
  if (!db) return false;

  await db.delete(domainEntity).where(eq(domainEntity.id, id));
  return true;
}
