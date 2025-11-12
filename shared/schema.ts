import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const cameras = pgTable("cameras", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  channelId: text("channel_id").notNull(),
  name: text("name").notNull(),
  streamUrl: text("stream_url").notNull(),
  streamType: text("stream_type").notNull(),
  username: text("username"),
  password: text("password"),
  location: text("location"),
  recordingPolicy: text("recording_policy").notNull().default("continuous"),
  status: text("status").notNull().default("inactive"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const recordings = pgTable("recordings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cameraId: varchar("camera_id").notNull().references(() => cameras.id),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time"),
  filePath: text("file_path").notNull(),
  duration: integer("duration"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertCameraSchema = createInsertSchema(cameras).omit({
  id: true,
  createdAt: true,
  status: true,
}).extend({
  recordingPolicy: z.string().default("continuous"),
});

export const insertRecordingSchema = createInsertSchema(recordings).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertCamera = z.infer<typeof insertCameraSchema>;
export type Camera = typeof cameras.$inferSelect;
export type InsertRecording = z.infer<typeof insertRecordingSchema>;
export type Recording = typeof recordings.$inferSelect;
