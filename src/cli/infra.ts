import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, parse } from "dotenv";

import { AnalysisStore } from "../analysis/store.js";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));

try {
  await docker(["compose", "version"]);
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  await createIfMissing(".env", await readFile(".env.example", "utf8"));
  const agentEnv = parse(await readFile(".env"));
  const defaults = {
    SEARXNG_SECRET: secret(),
    SEARXNG_BASE_URL: "http://localhost:8080",
    LANGFUSE_BASE_URL: "http://localhost:4000",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!agentEnv[key]?.trim() && !process.env[key]?.trim())
      await appendFile(".env", `\n${key}=${value}\n`);
  }
  config();

  const serviceEnvPath = resolve(
    process.env.LANGFUSE_ENV_FILE || ".langfuse.env",
  );
  const serviceEnv = parse(await readFile(".langfuse.env.example"));
  for (const key of [
    "NEXTAUTH_SECRET",
    "SALT",
    "ENCRYPTION_KEY",
    "POSTGRES_PASSWORD",
    "CLICKHOUSE_PASSWORD",
    "REDIS_AUTH",
    "MINIO_ROOT_PASSWORD",
  ])
    serviceEnv[key] = secret();
  serviceEnv.DATABASE_URL = `postgresql://postgres:${serviceEnv.POSTGRES_PASSWORD}@postgres:5432/postgres`;
  serviceEnv.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY =
    serviceEnv.MINIO_ROOT_PASSWORD;
  serviceEnv.LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY =
    serviceEnv.MINIO_ROOT_PASSWORD;
  await createIfMissing(
    serviceEnvPath,
    "# Generated local Langfuse credentials. Keep this file private.\n" +
      Object.entries(serviceEnv)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
  );
  const existing = parse(await readFile(serviceEnvPath));
  const invalidKeys = Object.keys(serviceEnv).filter(
    (key) => !existing[key]?.trim(),
  );
  if (invalidKeys.length)
    throw new Error(
      `Configure ${invalidKeys.join(", ")} in ${serviceEnvPath}; existing secrets are never replaced.`,
    );
  if (!/^[a-f\d]{64}$/i.test(existing.ENCRYPTION_KEY))
    throw new Error(
      "Langfuse ENCRYPTION_KEY must be 64 hexadecimal characters.",
    );

  const compose = ["compose", "-f", "docker-compose.yml"];
  await docker([...compose, "config", "--quiet"]);
  // Free port 8080 when upgrading from the former standalone deployment.
  // Stop only its search container; retain its container and cache volume.
  await docker([...compose, "-p", "prcouch-searxng", "stop", "searxng"]);
  await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "300"]);

  const store = new AnalysisStore();
  store.close();
  console.log(`SQLite ready: ${store.path}`);
  console.log("SearXNG: http://localhost:8080");
  console.log("Langfuse: http://localhost:4000");
  console.log(
    "For tracing, create Langfuse project API keys and add them to .env. Start the agent with npm start.",
  );
} catch (error) {
  console.error(
    `Infrastructure startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(
    "Check Docker is running; inspect services with npm run infra:logs.",
  );
  process.exitCode = 1;
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

async function createIfMissing(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
    console.log(`Created ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function docker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`docker ${args.join(" ")} exited with ${signal || code}.`),
        );
    });
  });
}
