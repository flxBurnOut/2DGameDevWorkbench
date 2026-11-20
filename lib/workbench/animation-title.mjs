/** An open-motion plan can already name its character anywhere in the action title. */
export function animationTitle(characterName, actionName) {
  const character = characterName?.trim() || '角色';
  const action = actionName?.trim() || '动作';
  return action.toLowerCase().includes(character.toLowerCase()) ? action : `${character} · ${action}`;
}
