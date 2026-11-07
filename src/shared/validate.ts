// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Dependency-free runtime validators for IPC payloads. Every payload crossing
// the bridge is checked structurally before it reaches the service layer.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type Validator<T> = (v: unknown) => T;

export const vString: Validator<string> = (v) => {
  if (typeof v !== "string") throw new ValidationError("expected string");
  return v;
};

export const vNonEmptyString = (max = 4000): Validator<string> => (v) => {
  const s = vString(v);
  if (s.length === 0 || s.length > max) throw new ValidationError("string length out of range");
  return s;
};

/** Length-bounded but empty-allowed — for payloads where emptiness is a
 *  semantic the engine itself validates (e.g. attachment-carried turns). */
export const vMaxString = (max: number): Validator<string> => (v) => {
  const s = vString(v);
  if (s.length > max) throw new ValidationError("string length out of range");
  return s;
};

export const vBoolean: Validator<boolean> = (v) => {
  if (typeof v !== "boolean") throw new ValidationError("expected boolean");
  return v;
};

export const vInt = (min: number, max: number): Validator<number> => (v) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new ValidationError("expected integer in range");
  return v;
};

export const vNumber = (min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): Validator<number> =>
  (v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw new ValidationError("expected number in range");
    return v;
  };

/** Byte payload (structured-cloned Uint8Array) with a hard size cap —
 *  used where the renderer legitimately holds bytes (paste/drop Files)
 *  but must never turn that into a file-path primitive. */
export const vBlob = (maxBytes: number): Validator<Uint8Array> => (v) => {
  if (!(v instanceof Uint8Array))
    throw new ValidationError("expected byte payload");
  if (v.byteLength > maxBytes) throw new ValidationError("byte payload too large");
  return v;
};

export const vArray = <T>(inner: Validator<T>, maxLen = 100000): Validator<T[]> => (v) => {
  if (!Array.isArray(v) || v.length > maxLen)
    throw new ValidationError("expected array within length bound");
  return v.map((item, i) => {
    try {
      return inner(item);
    } catch (e) {
      if (e instanceof ValidationError)
        throw new ValidationError(`item ${i}: ${e.message}`);
      throw e;
    }
  });
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Path-traversal and injection resistant: only real UUIDs identify objects. */
export const vId: Validator<string> = (v) => {
  const s = vString(v);
  if (!UUID_RE.test(s)) throw new ValidationError("expected uuid");
  return s;
};

export const vEnum = <T extends string>(allowed: readonly T[]): Validator<T> => (v) => {
  const s = vString(v) as T;
  if (!allowed.includes(s)) throw new ValidationError(`expected one of ${allowed.join(",")}`);
  return s;
};

export const vOptional = <T>(inner: Validator<T>): Validator<T | undefined> => (v) =>
  v === undefined ? undefined : inner(v);

export const vNullable = <T>(inner: Validator<T>): Validator<T | null> => (v) =>
  v === null ? null : inner(v);

/** Strict object: every listed field is validated, unknown keys are rejected. */
export function vObject<T extends Record<string, Validator<unknown>>>(
  fields: T,
): Validator<{ [K in keyof T]: ReturnType<T[K]> }> {
  return (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new ValidationError("expected object");
    const rec = v as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!(key in fields)) throw new ValidationError(`unexpected key "${key}"`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, fn] of Object.entries(fields)) {
      try {
        out[key] = fn(rec[key]);
      } catch (e) {
        if (e instanceof ValidationError)
          throw new ValidationError(`field "${key}": ${e.message}`);
        throw e;
      }
    }
    return out as { [K in keyof T]: ReturnType<T[K]> };
  };
}
