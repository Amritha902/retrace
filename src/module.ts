import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSpec, BudgetSpec, Provider, Tool } from "./types.ts";

/**
 * The half of a run a log cannot hold: tool implementations to execute and a
 * provider to call. `retrace replay` and `retrace fork` load one of these and
 * take everything else — input, model, system prompt, budget — from the
 * recorded run.
 */
export interface RunModule {
  tools?: Tool[];
  provider?: Provider;
  /** Merged over the recorded agent spec. This is what a fork usually changes. */
  agent?: Partial<AgentSpec>;
  input?: string;
  budget?: BudgetSpec;
}

/**
 * Import a module and check the shape of what it exported.
 *
 * Named exports win over the default export, so both styles work:
 *
 *     export const tools = [search];
 *     export default { tools: [search] };
 */
export async function loadRunModule(path: string): Promise<RunModule> {
  const url = pathToFileURL(resolve(path)).href;
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(url)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`cannot load module "${path}": ${describe(cause)}`);
  }

  const fallback = asRecord(loaded["default"]) ?? {};
  const pick = (key: string): unknown => loaded[key] ?? fallback[key];

  return {
    tools: readTools(path, pick("tools")),
    provider: readProvider(path, pick("provider")),
    agent: readObject(path, "agent", pick("agent")) as Partial<AgentSpec> | undefined,
    input: readString(path, "input", pick("input")),
    budget: readObject(path, "budget", pick("budget")) as BudgetSpec | undefined,
  };
}

function readTools(path: string, value: unknown): Tool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `module "${path}" exports "tools" as ${typeName(value)}; expected an array of tools`,
    );
  }
  return value.map((entry, i) => {
    const tool = asRecord(entry);
    if (!tool || typeof tool["name"] !== "string") {
      throw new Error(
        `module "${path}" exports tools[${i}] with no name; build tools with tool({ name, description, inputSchema, run })`,
      );
    }
    if (typeof tool["run"] !== "function") {
      throw new Error(
        `module "${path}" exports a tool named "${tool["name"]}" with no run function; build it with tool({ ... }) from retrace`,
      );
    }
    return tool as unknown as Tool;
  });
}

function readProvider(path: string, value: unknown): Provider | undefined {
  if (value === undefined) return undefined;
  const provider = asRecord(value);
  if (!provider || typeof provider["complete"] !== "function") {
    throw new Error(
      `module "${path}" exports "provider" as ${typeName(value)}; expected a provider with a complete() method`,
    );
  }
  return provider as unknown as Provider;
}

function readObject(
  path: string,
  key: string,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `module "${path}" exports "${key}" as ${typeName(value)}; expected an object of fields to override`,
    );
  }
  return record;
}

function readString(path: string, key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`module "${path}" exports "${key}" as ${typeName(value)}; expected a string`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
