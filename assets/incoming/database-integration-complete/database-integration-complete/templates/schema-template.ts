import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, boolean, decimal } from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

/**
 * TEMPLATE: User Table (Core)
 * Every database needs a users table for authentication.
 * Customize fields as needed for your domain.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * TEMPLATE: Domain-Specific Table
 * Replace with your actual business entity.
 * Example: todos, posts, products, incidents, etc.
 */
export const domainEntity = mysqlTable("domain_entity", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", ["active", "inactive", "archived"]).default("active").notNull(),
  metadata: json("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DomainEntity = typeof domainEntity.$inferSelect;
export type InsertDomainEntity = typeof domainEntity.$inferInsert;

/**
 * TEMPLATE: Relations
 * Define relationships between tables for type-safe queries.
 */
export const usersRelations = relations(users, ({ many }) => ({
  domainEntities: many(domainEntity),
}));

export const domainEntityRelations = relations(domainEntity, ({ one }) => ({
  user: one(users, {
    fields: [domainEntity.userId],
    references: [users.id],
  }),
}));
