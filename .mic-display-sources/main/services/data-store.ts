// Generic JSON persistence over userData. Every store is an instance of this class.

import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
  ) {}

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = getUserDataPath();
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, this.filename);
    }
    return this.filePath;
  }

  async load(): Promise<T> {
    if (this.cache !== null) return this.cache;
    try {
      const filePath = await this.getFilePath();
      const data = await fs.readFile(filePath, "utf-8");
      this.cache = JSON.parse(data) as T;
      return this.cache;
    } catch {
      // File doesn't exist yet — return defaults.
      this.cache = this.defaultValue;
      return this.cache;
    }
  }

  async save(data: T): Promise<void> {
    this.cache = data;
    const filePath = await this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Reload from disk, discarding the in-memory cache. */
  async reload(): Promise<T> {
    this.cache = null;
    return this.load();
  }
}
