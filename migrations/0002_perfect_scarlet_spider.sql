ALTER TABLE "cameras" ADD COLUMN "stream_mode" text;--> statement-breakpoint
ALTER TABLE "cameras" ADD COLUMN "is_streaming" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cameras" ADD COLUMN "last_stream_pid" text;--> statement-breakpoint
ALTER TABLE "cameras" ADD COLUMN "hls_path" text;--> statement-breakpoint
ALTER TABLE "cameras" ADD COLUMN "recording_folder" text;--> statement-breakpoint
ALTER TABLE "cameras" ADD COLUMN "last_started_at" timestamp;