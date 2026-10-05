import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

let spanProcessor: LangfuseSpanProcessor | undefined;

/** Tracing is optional, but a configured project needs both API keys. */
export function initializeCliTracing(): NodeSDK | undefined {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey && !secretKey) return undefined;
  if (!publicKey || !secretKey) {
    throw new Error(
      "Langfuse tracing requires both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.",
    );
  }

  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim();
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      throw new Error("LANGFUSE_BASE_URL must be a valid URL.");
    }
  }

  spanProcessor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    ...(baseUrl && { baseUrl }),
  });
  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  return sdk;
}

/** Export completed turns while the interactive session stays open. */
export async function flushCliTracing(): Promise<void> {
  await spanProcessor?.forceFlush();
}
