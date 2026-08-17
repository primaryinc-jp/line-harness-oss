export function splitSqlStatements(sql) {
  const triggerBlocks = [];
  const withoutTriggers = sql.replace(
    /CREATE\s+TRIGGER[\s\S]*?\nEND;/gi,
    (statement) => {
      const marker = `__LINE_HARNESS_TRIGGER_${triggerBlocks.length}__`;
      triggerBlocks.push(statement.trim());
      return marker;
    },
  );
  const statements = withoutTriggers
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => statement.replace(
      /__LINE_HARNESS_TRIGGER_(\d+)__/g,
      (_marker, index) => triggerBlocks[Number(index)],
    ));
  return statements;
}
