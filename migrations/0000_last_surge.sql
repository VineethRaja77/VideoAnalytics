CREATE TABLE "cameras" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"name" text NOT NULL,
	"stream_url" text NOT NULL,
	"stream_type" text NOT NULL,
	"username" text,
	"password" text,
	"location" text,
	"recording_policy" text DEFAULT 'continuous' NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camera_id" varchar NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp,
	"file_path" text NOT NULL,
	"duration" integer
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE no action ON UPDATE no action;