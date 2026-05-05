import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infra/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.PIPELINE_DB_PATH ?? "./work/pipeline.sqlite3",
  },
});
