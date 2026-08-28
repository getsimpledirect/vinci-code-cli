// VENDORED BY COPY — do not edit here without re-syncing the source.
//   source:  vinci-contracts @ b2e0188b (PR #20)
//   file:    packages/contracts/src/canonical.ts (`canonicalize`)
// The contracts package lives on a private registry, so the worker carries a byte-for-byte port
// instead of a dependency. vinci/test/worker-contract-vectors.mjs pins this port to the golden
// vectors copied from packages/work-orders/vectors/ at the same commit; a drift between the two
// implementations shows up there as a failing test, never as a digest that quietly disagrees.
//
// Rules (RFC 8785 / JCS for the value domain in use), stated so an independent implementation
// can agree byte for byte:
//   - object keys sorted by UTF-16 code unit, recursively, at every level;
//   - arrays keep their order, because position in an array is meaning;
//   - `undefined`-valued properties omitted, matching JSON;
//   - numbers encoded by JSON.stringify (ES Number::toString: exact for safe integers);
//   - strings escaped by JSON.stringify;
//   - non-finite numbers and unsupported types throw rather than encode, because silently
//     encoding them would make two records with different content share an identity.
export function canonicalize(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (type === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize a value of type ${type}`);
}
