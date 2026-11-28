/** Advisory only: deliberate darkening is valid and must remain adoptable. */
export function imageDarkeningWarning(before, after) {
  if (before.length !== after.length) return null;
  let changedVisible = 0, newlyDark = 0;
  for (let offset = 0; offset < after.length; offset += 4) {
    if (after[offset + 3] < 32 || before[offset + 3] < 32) continue;
    if (after[offset] === before[offset] && after[offset + 1] === before[offset + 1] && after[offset + 2] === before[offset + 2]) continue;
    changedVisible++;
    const dark = after[offset] < 12 && after[offset + 1] < 12 && after[offset + 2] < 12;
    const wasDark = before[offset] < 12 && before[offset + 1] < 12 && before[offset + 2] < 12;
    if (dark && !wasDark) newlyDark++;
  }
  return newlyDark >= 64 && newlyDark / changedVisible >= 0.65 ? { code: 'large-dark-patch', changedVisible, newlyDark } : null;
}
