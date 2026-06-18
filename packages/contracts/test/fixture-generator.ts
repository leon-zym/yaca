import { type Static, type TSchema } from "typebox";
import * as Value from "typebox/value";

const minimumFixtureCache = new WeakMap<TSchema, unknown>();
const maximumStringCache = new WeakMap<TSchema, { valid: string; invalid: string } | null>();

function cloneSchema(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const clone: Record<PropertyKey, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    (clone as Record<PropertyKey, unknown>)[key] = cloneSchema(child, seen);
  }
  if (!Array.isArray(clone)) {
    const source = value as Record<PropertyKey, unknown>;
    if (source.type === "string" && source.const === undefined) {
      const minimumLength = typeof source.minLength === "number" ? source.minLength : 0;
      const candidates = ["", "x", "0", ".", "1970-01-01T00:00:00.000Z", "x".repeat(minimumLength)];
      const candidate = candidates.find((item) => Value.Check(value as TSchema, item));
      if (candidate !== undefined) clone.default = candidate;
    }
    if (source.type === "array" && source.uniqueItems === true) {
      const minimumItems = typeof source.minItems === "number" ? source.minItems : 0;
      const items = clone.items as TSchema;
      clone.default = Array.from({ length: minimumItems }, () => Value.Create(items));
    }
    if (source.$defs !== undefined && source.$ref !== undefined) clone.default = {};
  }
  return clone;
}

function normalizeCrossFieldInvariants(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeCrossFieldInvariants(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (object.declarationStatus === "preparing" && typeof object.name === "string") {
    object.summary = object.name;
    object.toolKind = ["read", "edit", "write", "bash"].includes(object.name)
      ? object.name
      : "unknown";
  }
  for (const child of Object.values(object)) normalizeCrossFieldInvariants(child);
}

export function createMinimumFixture<T extends TSchema>(schema: T): Static<T> {
  const cached = minimumFixtureCache.get(schema);
  if (cached !== undefined) return structuredClone(cached) as Static<T>;
  const fixtureSchema = cloneSchema(schema) as T;
  const fixture = Value.Create(fixtureSchema);
  normalizeCrossFieldInvariants(fixture);
  if (!Value.Check(schema, fixture)) throw new Error("Unable to generate a valid protocol fixture");
  minimumFixtureCache.set(schema, fixture);
  return structuredClone(fixture);
}

export interface BoundaryFixture {
  readonly path: string;
  readonly valid: unknown;
  readonly invalid: unknown;
}

function atPath(root: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  if (path.length === 0) return structuredClone(replacement);
  const clone = structuredClone(root);
  let target = clone as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    target = target[segment] as Record<string | number, unknown>;
  }
  target[path.at(-1) as string | number] = structuredClone(replacement);
  normalizeCrossFieldInvariants(clone);
  return clone;
}

function uniqueItems(schema: TSchema, count: number): unknown[] {
  const values: unknown[] = [];
  const enumValues = (schema as { enum?: unknown[] }).enum;
  if (enumValues !== undefined) return enumValues.slice(0, count);
  const anyOf = (schema as { anyOf?: Array<{ const?: unknown }> }).anyOf;
  if (anyOf?.every((item) => item.const !== undefined)) {
    return anyOf.slice(0, count).map((item) => item.const);
  }
  for (let index = 0; values.length < count && index < count * 10 + 10; index += 1) {
    for (const candidate of [`x${index}`, `${index}`]) {
      if (Value.Check(schema, candidate) && !values.includes(candidate)) values.push(candidate);
      if (values.length === count) break;
    }
  }
  if (values.length !== count) {
    throw new Error(
      `Unable to generate unique array boundary (${values.length}/${count}): ${JSON.stringify(schema)}`,
    );
  }
  return values;
}

function maximumString(
  schema: TSchema,
  minimum: string,
): { valid: string; invalid: string } | null {
  if (maximumStringCache.has(schema)) return maximumStringCache.get(schema) ?? null;
  const node = schema as { format?: unknown; maxLength?: unknown };
  if (node.format !== undefined) {
    const valid = `1970-01-01T00:00:00.${"1".repeat(17)}Z`;
    const invalid = `1970-01-01T00:00:00.${"1".repeat(18)}Z`;
    const result =
      Value.Check(schema, valid) && !Value.Check(schema, invalid) ? { valid, invalid } : null;
    maximumStringCache.set(schema, result);
    return result;
  }
  const character = minimum[0] ?? "x";
  let low = minimum.length;
  let high = typeof node.maxLength === "number" ? node.maxLength + 1 : Math.max(low + 1, 2);
  while (high < 1_100_000 && Value.Check(schema, character.repeat(high))) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, 1_100_000);
  if (Value.Check(schema, character.repeat(high))) {
    maximumStringCache.set(schema, null);
    return null;
  }
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (Value.Check(schema, character.repeat(middle))) low = middle;
    else high = middle;
  }
  const valid = character.repeat(low);
  const invalid = character.repeat(low + 1);
  const result =
    Value.Check(schema, valid) && !Value.Check(schema, invalid) ? { valid, invalid } : null;
  maximumStringCache.set(schema, result);
  return result;
}

export function createBoundaryFixtures<T extends TSchema>(schema: T): BoundaryFixture[] {
  const rootMinimum = createMinimumFixture(schema);
  const fixtures: BoundaryFixture[] = [];
  const add = (
    path: readonly (string | number)[],
    base: unknown,
    validValue: unknown,
    invalidValue: unknown,
  ) => {
    const valid = atPath(base, path, validValue);
    const invalid = atPath(base, path, invalidValue);
    if (Value.Check(schema, valid) && !Value.Check(schema, invalid)) {
      fixtures.push({ path: path.join("."), valid, invalid });
    }
  };
  const walk = (
    currentSchema: TSchema,
    current: unknown,
    path: readonly (string | number)[],
    base: unknown,
    depth: number,
  ): void => {
    if (depth > 32) return;
    const node = currentSchema as Record<string, unknown>;
    const anyOf = node.anyOf as TSchema[] | undefined;
    if (anyOf !== undefined) {
      if (anyOf.every((branch) => (branch as { const?: unknown }).const !== undefined)) return;
      for (const branch of anyOf) {
        try {
          const branchMinimum = createMinimumFixture(branch);
          walk(branch, branchMinimum, path, atPath(base, path, branchMinimum), depth + 1);
        } catch {
          // A branch with unresolved cyclic references is covered by its enclosing refinement.
        }
      }
      return;
    }
    if (node.$defs !== undefined && node.$ref !== undefined) {
      const stringBoundary = maximumString(currentSchema, "");
      if (stringBoundary !== null) add(path, base, stringBoundary.valid, stringBoundary.invalid);
      return;
    }
    if (node.type === "string" && typeof current === "string") {
      const boundary = maximumString(currentSchema, current);
      if (boundary !== null) add(path, base, boundary.valid, boundary.invalid);
      return;
    }
    if ((node.type === "integer" || node.type === "number") && typeof node.maximum === "number") {
      add(path, base, node.maximum, node.maximum + 1);
      return;
    }
    if (node.type === "array" && typeof node.maxItems === "number") {
      const itemSchema = node.items as TSchema;
      const validItems =
        node.uniqueItems === true
          ? uniqueItems(itemSchema, node.maxItems)
          : Array.from({ length: node.maxItems }, () => createMinimumFixture(itemSchema));
      const invalidItems = [...validItems, createMinimumFixture(itemSchema)];
      add(path, base, validItems, invalidItems);
      if (node.maxItems > 0) {
        const item = createMinimumFixture(itemSchema);
        const itemBase = atPath(base, path, [item]);
        walk(itemSchema, item, [...path, 0], itemBase, depth + 1);
      }
      return;
    }
    if (node.type === "object") {
      const properties = (node.properties ?? {}) as Record<string, TSchema>;
      for (const [key, propertySchema] of Object.entries(properties)) {
        let child = (current as Record<string, unknown> | null)?.[key];
        let childBase = base;
        if (child === undefined) {
          try {
            child = createMinimumFixture(propertySchema);
            childBase = atPath(base, [...path, key], child);
          } catch {
            continue;
          }
        }
        walk(propertySchema, child, [...path, key], childBase, depth + 1);
      }
    }
  };
  walk(schema, rootMinimum, [], rootMinimum, 0);
  return fixtures;
}
