import { type User, type InsertUser, type Camera, type InsertCamera, type Recording, type InsertRecording } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Camera methods
  getAllCameras(): Promise<Camera[]>;
  getCamera(id: string): Promise<Camera | undefined>;
  createCamera(camera: InsertCamera): Promise<Camera>;
  updateCamera(id: string, camera: Partial<InsertCamera>): Promise<Camera | undefined>;
  updateCameraStatus(id: string, status: string): Promise<Camera | undefined>;
  deleteCamera(id: string): Promise<boolean>;

  // Recording methods
  getRecordingsByCamera(cameraId: string, startDate?: Date, endDate?: Date): Promise<Recording[]>;
  createRecording(recording: InsertRecording): Promise<Recording>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private cameras: Map<string, Camera>;
  private recordings: Map<string, Recording>;

  constructor() {
    this.users = new Map();
    this.cameras = new Map();
    this.recordings = new Map();

    // Add default user for testing
    const defaultUser: User = {
      id: randomUUID(),
      username: "admin",
      password: "admin123", // In production, this would be hashed
    };
    this.users.set(defaultUser.id, defaultUser);

    // Add some default cameras for testing
    const defaultCameras: Camera[] = [
      {
        id: randomUUID(),
        channelId: "4",
        name: "CP IP Cam",
        streamUrl: "rtsp://192.168.0.100:554/stream1",
        streamType: "RTSP",
        username: "admin",
        password: "",
        location: "Building A - Main Entrance",
        recordingPolicy: "continuous",
        status: "online",
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        channelId: "5",
        name: "CP IP Cam",
        streamUrl: "rtsp://192.168.0.101:554/stream1",
        streamType: "RTSP",
        username: "admin",
        password: "",
        location: "Building A - Parking Lot",
        recordingPolicy: "continuous",
        status: "online",
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        channelId: "6",
        name: "CP IP Cam",
        streamUrl: "rtsp://192.168.0.102:554/stream1",
        streamType: "RTSP",
        username: "admin",
        password: "",
        location: "Building B - Reception",
        recordingPolicy: "motion",
        status: "offline",
        createdAt: new Date(),
      },
    ];

    defaultCameras.forEach(camera => this.cameras.set(camera.id, camera));
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  // Camera methods
  async getAllCameras(): Promise<Camera[]> {
    return Array.from(this.cameras.values());
  }

  async getCamera(id: string): Promise<Camera | undefined> {
    return this.cameras.get(id);
  }

  async createCamera(insertCamera: InsertCamera): Promise<Camera> {
    const id = randomUUID();
    const camera: Camera = {
      id,
      channelId: insertCamera.channelId,
      name: insertCamera.name,
      streamUrl: insertCamera.streamUrl,
      streamType: insertCamera.streamType,
      username: insertCamera.username ?? null,
      password: insertCamera.password ?? null,
      location: insertCamera.location ?? null,
      recordingPolicy: insertCamera.recordingPolicy ?? "continuous",
      status: "inactive",
      createdAt: new Date(),
    };
    this.cameras.set(id, camera);
    return camera;
  }

  async updateCamera(id: string, updates: Partial<InsertCamera>): Promise<Camera | undefined> {
    const camera = this.cameras.get(id);
    if (!camera) return undefined;

    const updated = { ...camera, ...updates };
    this.cameras.set(id, updated);
    return updated;
  }

  async updateCameraStatus(id: string, status: string): Promise<Camera | undefined> {
    const camera = this.cameras.get(id);
    if (!camera) return undefined;

    const updated = { ...camera, status };
    this.cameras.set(id, updated);
    return updated;
  }

  async deleteCamera(id: string): Promise<boolean> {
    return this.cameras.delete(id);
  }

  // Recording methods
  async getRecordingsByCamera(cameraId: string, startDate?: Date, endDate?: Date): Promise<Recording[]> {
    let recordings = Array.from(this.recordings.values()).filter(
      (r) => r.cameraId === cameraId
    );

    if (startDate) {
      recordings = recordings.filter((r) => r.startTime >= startDate);
    }

    if (endDate) {
      recordings = recordings.filter((r) => r.startTime <= endDate);
    }

    return recordings.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  }

  async createRecording(insertRecording: InsertRecording): Promise<Recording> {
    const id = randomUUID();
    const recording: Recording = {
      id,
      cameraId: insertRecording.cameraId,
      startTime: insertRecording.startTime,
      endTime: insertRecording.endTime ?? null,
      filePath: insertRecording.filePath,
      duration: insertRecording.duration ?? null,
    };
    this.recordings.set(id, recording);
    return recording;
  }
}

export const storage = new MemStorage();
