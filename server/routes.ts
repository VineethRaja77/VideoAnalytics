import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertCameraSchema } from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(app: Express): Promise<Server> {
  // Authentication
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      const user = await storage.getUserByUsername(username);
      if (!user || user.password !== password) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // In production, use proper session management
      res.json({ 
        success: true, 
        user: { id: user.id, username: user.username } 
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all cameras
  app.get("/api/cameras", async (req, res) => {
    try {
      const cameras = await storage.getAllCameras();
      res.json(cameras);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch cameras" });
    }
  });

  // Get single camera
  app.get("/api/cameras/:id", async (req, res) => {
    try {
      const camera = await storage.getCamera(req.params.id);
      if (!camera) {
        return res.status(404).json({ error: "Camera not found" });
      }
      res.json(camera);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch camera" });
    }
  });

  // Create camera
  app.post("/api/cameras", async (req, res) => {
    try {
      const validated = insertCameraSchema.parse(req.body);
      const camera = await storage.createCamera(validated);
      res.status(201).json(camera);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid camera data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create camera" });
    }
  });

  // Update camera
  app.patch("/api/cameras/:id", async (req, res) => {
    try {
      const camera = await storage.updateCamera(req.params.id, req.body);
      if (!camera) {
        return res.status(404).json({ error: "Camera not found" });
      }
      res.json(camera);
    } catch (error) {
      res.status(500).json({ error: "Failed to update camera" });
    }
  });

  // Update camera status
  app.patch("/api/cameras/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) {
        return res.status(400).json({ error: "Status is required" });
      }

      const camera = await storage.updateCameraStatus(req.params.id, status);
      if (!camera) {
        return res.status(404).json({ error: "Camera not found" });
      }
      res.json(camera);
    } catch (error) {
      res.status(500).json({ error: "Failed to update camera status" });
    }
  });

  // Delete camera
  app.delete("/api/cameras/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteCamera(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Camera not found" });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete camera" });
    }
  });

  // Test camera connection
  app.post("/api/cameras/test-connection", async (req, res) => {
    try {
      const { streamUrl, streamType, username, password } = req.body;
      
      // Simulate connection test
      // In production, this would actually try to connect to the stream
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const isValid = streamUrl && streamUrl.startsWith("rtsp://");
      
      res.json({
        success: isValid,
        message: isValid ? "Connection successful" : "Connection failed - Invalid stream URL"
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to test connection" });
    }
  });

  // Get recordings for a camera
  app.get("/api/cameras/:id/recordings", async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      const start = startDate ? new Date(startDate as string) : undefined;
      const end = endDate ? new Date(endDate as string) : undefined;
      
      const recordings = await storage.getRecordingsByCamera(
        req.params.id,
        start,
        end
      );
      
      res.json(recordings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch recordings" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
