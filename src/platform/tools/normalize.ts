/**
 * Blank arguments the model never meant.
 *
 * Some models materialize EVERY schema property instead of omitting the ones they do not mean
 * (`{what:'text', query:'', ref:'', region:{x:0,y:0,width:0,height:0}}`). Guards read PRESENCE,
 * not intent, so each blank would be refused. A blank optional is therefore deleted once, at the
 * tool boundary, before any guard runs.
 *
 * OPTIONAL is read off the schema's own `required` list, never a hand-kept field list: a
 * REQUIRED blank is a real value (`set_text` with `text:''` clears a field) and must survive.
 */

import type { TSchema } from "typebox";

/** The runtime face of a typebox schema: plain JSON Schema. */
interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  const?: unknown;
}

type Row = Record<string, unknown>;

/** Carries no intent: whitespace-only text, or an all-zero box (the materialized `region`,
 * which no caller can mean — a crop needs a positive width and height). */
function isBlank(v: unknown): boolean {
  if (typeof v === "string") return v.trim() === "";
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every((n) => n === 0);
}

/** A union variant describes this value when every literal it pins agrees — `kind:'wait'`.
 * That is what lets `text` be REQUIRED for set_text and optional for wait without a field list. */
function describes(obj: Row, variant: JsonSchema): boolean {
  const pinned = Object.entries(variant.properties ?? {}).filter(([, s]) => s.const !== undefined);
  return pinned.length > 0 && pinned.every(([key, s]) => obj[key] === s.const);
}

/** The object shapes that describe this value: the schema itself, or — for a union — the
 * variants that match. Plus, because an action may arrive FLATTENED ({kind:…} instead
 * of {action:{kind:…}}), the variants of a union-typed property that did not arrive. */
function shapesFor(obj: Row, schema: JsonSchema): JsonSchema[] {
  if (schema.anyOf) return schema.anyOf.filter((v) => describes(obj, v));
  const flattened = Object.entries(schema.properties ?? {})
    .filter(([key, sub]) => sub.anyOf && !(key in obj))
    .flatMap(([, sub]) => sub.anyOf!.filter((v) => describes(obj, v)));
  return [schema, ...flattened];
}

/** Delete the blank optionals of one object, in place, then descend into what is left.
 * Arrays are deliberately NOT walked: `then`'s step schema marks every field optional
 * because one shape covers four verbs, so `required` there says nothing about intent and
 * `stepList` is what validates a step. */
function strip(value: unknown, schema: JsonSchema): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const obj = value as Row;
  for (const shape of shapesFor(obj, schema)) {
    const required = shape.required ?? [];
    for (const [key, sub] of Object.entries(shape.properties ?? {})) {
      if (!(key in obj)) continue;
      if (!required.includes(key) && isBlank(obj[key])) delete obj[key];
      else strip(obj[key], sub);
    }
  }
}

/** A copy of the model's arguments with every blank optional absent. Never mutates the
 * original: the transcript must keep what the model actually sent. */
export function withoutBlankOptionals(params: unknown, schema: TSchema): unknown {
  if (typeof params !== "object" || params === null) return params;
  const copy = structuredClone(params);
  strip(copy, schema as JsonSchema);
  return copy;
}
