function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join() === keys;
}

export function acceptFixture(reply, runId, active) {
  if (!active || !exactKeys(reply, "run_id,status,value")) return false;
  if (reply.run_id !== runId || reply.status !== "result") return false;
  const value = reply.value;
  if (!exactKeys(value, "count,sum")) return false;
  return value.count === 3 && value.sum === 10;
}
