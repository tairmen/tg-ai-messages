export function aiSettingsUpdate(names, kind, target) {
  const contact = kind === "contact";
  if (!contact && kind !== "group")
    throw new Error("Unknown conversation kind");
  return {
    text: `UPDATE ${contact ? names.contacts : names.groups}
      SET ai_enabled=$1,ai_instructions=$2,ai_mode=$3,ai_interval_minutes=$4::integer,
      ai_revision=ai_revision+1,ai_next_run_at=now()+$4::integer*interval '1 minute'
      ${contact ? ",opted_out=$6" : ""} WHERE id=$5 RETURNING *`,
    values: [
      target.ai_enabled,
      target.ai_instructions,
      target.ai_mode,
      target.ai_interval_minutes,
      target.id,
      ...(contact ? [target.opted_out] : []),
    ],
  };
}
