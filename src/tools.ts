import type { Tool, ToolContext } from "./types.ts";

export interface ToolDefinition<I> {
  name: string;
  /**
   * What the tool does and, just as importantly, when to call it. Models reach
   * for tools based on this text — a description that only says what the tool
   * is will be under-called.
   */
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Set when running this does something that running it twice would do twice.
   * A fork, a resume or a replay that goes past its log refuses to execute it
   * rather than doing it again — see `Tool.irreversible`.
   */
  irreversible?: true;
  /** `context` is the journal: take time, ids and randomness from it to keep them replayable. */
  run(input: I, context: ToolContext): Promise<string> | string;
}

/** Define a tool. Thin by design — a tool is a name, a schema, and a function. */
export function tool<I = any>(definition: ToolDefinition<I>): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.irreversible ? { irreversible: true as const } : {}),
    run: definition.run as Tool["run"],
  };
}

/** Shorthand for the common `{ type: "object", properties, required }` schema. */
export function objectSchema(
  properties: Record<string, { type: string; description?: string; enum?: unknown[] }>,
  required: string[] = Object.keys(properties),
): Record<string, unknown> {
  return { type: "object", properties, required };
}
